/**
 * EV routing engine: Mapbox Directions + battery decay simulation + OCM stops.
 *
 * Algorithm:
 * 1. Request initial origin→destination route (mapbox/driving-traffic).
 * 2. Simulate SoC along the polyline with a 15% safety buffer.
 * 3. If range is insufficient, find the buffer intercept, query CCS2 chargers,
 *    insert the best station, and re-request multi-leg directions.
 * 4. Assume each stop charges to the configured target SoC (default 80%).
 */

import {
  DEFAULT_CHARGE_TARGET_PERCENT,
  DEFAULT_CHARGER_SEARCH_RADIUS_KM,
  DEFAULT_MAX_CHARGING_STOPS,
  DEFAULT_MIN_CHARGING_STOPS,
  DEFAULT_MIN_CHARGER_POWER_KW,
  DEFAULT_SAFETY_BUFFER_PERCENT,
  DEFAULT_WH_PER_KM,
  env,
} from "@/lib/config";
import {
  estimateChargeMinutes,
  selectOptimalCharger,
} from "@/lib/openChargeMap";
import type {
  ChargingStation,
  EVRoutePlanRequest,
  EVRouteResult,
  GeoPoint,
  RouteLeg,
} from "@/types";

const MAPBOX_DIRECTIONS_URL =
  "https://api.mapbox.com/directions/v5/mapbox/driving-traffic";

export class EvRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvRoutingError";
  }
}

type LngLat = [number, number];

interface MapboxRoute {
  distance: number; // meters
  duration: number; // seconds
  geometry: {
    type: "LineString";
    coordinates: LngLat[];
  };
}

interface MapboxDirectionsResponse {
  code: string;
  message?: string;
  routes?: MapboxRoute[];
}

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toPoint(coord: LngLat): GeoPoint {
  return { lng: coord[0], lat: coord[1] };
}

function formatCoord(point: GeoPoint): string {
  return `${point.lng},${point.lat}`;
}

/** Cumulative distance (km) along a GeoJSON LineString. */
function cumulativeDistancesKm(coords: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(
      out[i - 1] +
        haversineKm(toPoint(coords[i - 1]), toPoint(coords[i])),
    );
  }
  return out;
}

/**
 * Interpolate a coordinate at target distance along the path.
 */
function pointAtDistanceKm(
  coords: LngLat[],
  cumulativeKm: number[],
  targetKm: number,
): GeoPoint {
  if (coords.length === 0) {
    throw new EvRoutingError("Empty route geometry");
  }
  if (targetKm <= 0) return toPoint(coords[0]);

  const total = cumulativeKm[cumulativeKm.length - 1] ?? 0;
  if (targetKm >= total) return toPoint(coords[coords.length - 1]);

  for (let i = 1; i < cumulativeKm.length; i++) {
    if (cumulativeKm[i] >= targetKm) {
      const segStart = cumulativeKm[i - 1];
      const segEnd = cumulativeKm[i];
      const segLen = Math.max(segEnd - segStart, 1e-9);
      const t = (targetKm - segStart) / segLen;
      const a = coords[i - 1];
      const b = coords[i];
      return {
        lng: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
      };
    }
  }

  return toPoint(coords[coords.length - 1]);
}

/** Usable range in km before hitting the safety buffer SoC. */
export function maxReachableRangeKm(options: {
  socPercent: number;
  batteryCapacityKwh: number;
  averageWhPerKm: number;
  safetyBufferPercent: number;
}): number {
  const {
    socPercent,
    batteryCapacityKwh,
    averageWhPerKm,
    safetyBufferPercent,
  } = options;

  const usableSoc = Math.max(0, socPercent - safetyBufferPercent);
  const usableKwh = batteryCapacityKwh * (usableSoc / 100);
  if (averageWhPerKm <= 0) return 0;
  return (usableKwh * 1000) / averageWhPerKm;
}

function socAfterDistanceKm(options: {
  startSocPercent: number;
  distanceKm: number;
  batteryCapacityKwh: number;
  averageWhPerKm: number;
}): number {
  const energyKwh =
    (options.distanceKm * options.averageWhPerKm) / 1000;
  const deltaSoc =
    (energyKwh / Math.max(options.batteryCapacityKwh, 0.001)) * 100;
  return Math.max(0, options.startSocPercent - deltaSoc);
}

/**
 * Synthetic route used when Mapbox token is missing (offline / mock demos).
 * Builds a densified great-circle-ish polyline between waypoints.
 */
function mockDirections(waypoints: GeoPoint[]): MapboxRoute {
  const coordinates: LngLat[] = [];
  let distanceM = 0;
  const stepsPerLeg = 24;

  for (let w = 0; w < waypoints.length - 1; w++) {
    const a = waypoints[w];
    const b = waypoints[w + 1];
    for (let i = 0; i <= stepsPerLeg; i++) {
      if (w > 0 && i === 0) continue;
      const t = i / stepsPerLeg;
      const lng = a.lng + (b.lng - a.lng) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      // Slight lateral bend so the line isn't perfectly straight.
      const bend = Math.sin(t * Math.PI) * 0.02;
      coordinates.push([lng + bend * 0.15, lat + bend * 0.05]);
    }
    distanceM += haversineKm(a, b) * 1000;
  }

  const duration = (distanceM / 1000 / 85) * 3600; // ~85 km/h average
  return {
    distance: distanceM,
    duration,
    geometry: { type: "LineString", coordinates },
  };
}

async function fetchMapboxDirections(
  waypoints: GeoPoint[],
): Promise<MapboxRoute> {
  if (waypoints.length < 2) {
    throw new EvRoutingError("At least origin and destination are required");
  }

  const token = env.mapboxToken;
  if (!token) {
    console.warn(
      "[evRouting] No Mapbox token — using synthetic geometry fallback",
    );
    return mockDirections(waypoints);
  }

  const path = waypoints.map(formatCoord).join(";");
  const url = new URL(`${MAPBOX_DIRECTIONS_URL}/${path}`);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("steps", "false");
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text();
    console.warn(
      `[evRouting] Mapbox Directions ${res.status} — mock fallback:`,
      body.slice(0, 200),
    );
    return mockDirections(waypoints);
  }

  const json = (await res.json()) as MapboxDirectionsResponse;
  if (json.code !== "Ok" || !json.routes?.[0]) {
    console.warn(
      "[evRouting] Mapbox returned no routes — mock fallback:",
      json.message ?? json.code,
    );
    return mockDirections(waypoints);
  }

  return json.routes[0];
}

function buildLeg(options: {
  kind: RouteLeg["kind"];
  from: GeoPoint;
  to: GeoPoint;
  fromLabel: string;
  toLabel: string;
  route: MapboxRoute;
  socAtStartPercent: number;
  batteryCapacityKwh: number;
  averageWhPerKm: number;
}): RouteLeg {
  const distanceKm = options.route.distance / 1000;
  const durationMinutes = options.route.duration / 60;
  const socAtEndPercent = socAfterDistanceKm({
    startSocPercent: options.socAtStartPercent,
    distanceKm,
    batteryCapacityKwh: options.batteryCapacityKwh,
    averageWhPerKm: options.averageWhPerKm,
  });

  return {
    kind: options.kind,
    from: options.from,
    to: options.to,
    fromLabel: options.fromLabel,
    toLabel: options.toLabel,
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMinutes: Number(durationMinutes.toFixed(1)),
    geometry: {
      type: "LineString",
      coordinates: options.route.geometry.coordinates,
    },
    socAtStartPercent: Number(options.socAtStartPercent.toFixed(1)),
    socAtEndPercent: Number(socAtEndPercent.toFixed(1)),
  };
}

function mergeGeometry(legs: RouteLeg[]): EVRouteResult["fullGeometry"] {
  const coordinates: LngLat[] = [];
  for (const leg of legs) {
    for (const c of leg.geometry.coordinates) {
      const prev = coordinates[coordinates.length - 1];
      if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) {
        coordinates.push(c);
      }
    }
  }
  return { type: "LineString", coordinates };
}

/**
 * With a tight max-stop budget, charge higher; with many comfort stops, a lower
 * top-up is enough for shorter legs.
 */
function resolveChargeTargetPercent(options: {
  minChargingStops: number;
  maxChargingStops: number;
  requested?: number;
}): number {
  const base = options.requested ?? DEFAULT_CHARGE_TARGET_PERCENT;
  const { minChargingStops, maxChargingStops } = options;

  if (maxChargingStops <= 0) return base;
  if (maxChargingStops === 1) return Math.max(base, 95);
  if (maxChargingStops === 2 && minChargingStops <= 1) return Math.max(base, 90);
  if (minChargingStops >= 4) return Math.min(base, 70);
  if (minChargingStops >= 3) return Math.min(base, 75);
  if (maxChargingStops === 3 && minChargingStops <= 1) return Math.max(base, 85);
  return base;
}

/**
 * SoC after a stop: full target for range-critical stops; lighter top-up for comfort breaks.
 */
function resolveStopSocTarget(options: {
  socAtArrival: number;
  chargeTargetPercent: number;
  isRangeCritical: boolean;
  nextLegKm: number;
  batteryCapacityKwh: number;
  averageWhPerKm: number;
  safetyBufferPercent: number;
}): number {
  const {
    socAtArrival,
    chargeTargetPercent,
    isRangeCritical,
    nextLegKm,
    batteryCapacityKwh,
    averageWhPerKm,
    safetyBufferPercent,
  } = options;

  if (isRangeCritical) {
    return Math.max(socAtArrival, chargeTargetPercent);
  }

  // Comfort break: only top up enough for the next short leg + buffer, or +20%.
  const energyForNextKwh = (nextLegKm * averageWhPerKm) / 1000;
  const socForNext =
    (energyForNextKwh / Math.max(batteryCapacityKwh, 0.001)) * 100 +
    safetyBufferPercent;
  const comfortTarget = Math.max(socAtArrival + 20, socForNext);
  return Math.min(
    chargeTargetPercent,
    Math.max(socAtArrival, Math.min(95, comfortTarget)),
  );
}

/**
 * Plan an EV route with dynamic charging stops.
 * Honours min stops (shorter legs / comfort breaks) and max stops (range stretch).
 */
export async function planEvRoute(
  request: EVRoutePlanRequest,
): Promise<EVRouteResult> {
  const averageWhPerKm = request.averageWhPerKm ?? DEFAULT_WH_PER_KM;
  const safetyBufferPercent =
    request.safetyBufferPercent ?? DEFAULT_SAFETY_BUFFER_PERCENT;
  let maxChargingStops = Math.max(
    0,
    Math.min(
      8,
      Math.floor(request.maxChargingStops ?? DEFAULT_MAX_CHARGING_STOPS),
    ),
  );
  let minChargingStops = Math.max(
    0,
    Math.min(
      8,
      Math.floor(request.minChargingStops ?? DEFAULT_MIN_CHARGING_STOPS),
    ),
  );
  if (minChargingStops > maxChargingStops) {
    maxChargingStops = minChargingStops;
  }

  const chargeTargetPercent = resolveChargeTargetPercent({
    minChargingStops,
    maxChargingStops,
    requested: request.chargeTargetPercent,
  });
  const minChargerPowerKw =
    request.minChargerPowerKw ?? DEFAULT_MIN_CHARGER_POWER_KW;
  const chargerSearchRadiusKm =
    request.chargerSearchRadiusKm ?? DEFAULT_CHARGER_SEARCH_RADIUS_KM;

  const originLabel = request.originLabel ?? "Origin";
  const destinationLabel = request.destinationLabel ?? "Destination";
  const warnings: string[] = [];

  const initial = await fetchMapboxDirections([
    request.origin,
    request.destination,
  ]);

  const coords = initial.geometry.coordinates;
  const cumulative = cumulativeDistancesKm(coords);
  const totalDistanceKm = cumulative[cumulative.length - 1] ?? 0;

  // Preferred max driving stretch when the user wants frequent breaks.
  const comfortLegKm =
    minChargingStops > 0
      ? totalDistanceKm / (minChargingStops + 1)
      : Number.POSITIVE_INFINITY;

  let reachableKm = maxReachableRangeKm({
    socPercent: request.socPercent,
    batteryCapacityKwh: request.batteryCapacityKwh,
    averageWhPerKm,
    safetyBufferPercent,
  });

  const legs: RouteLeg[] = [];
  const chargingStops: ChargingStation[] = [];
  const usedChargerIds = new Set<string>();
  let totalChargingMinutes = 0;
  let currentSoc = request.socPercent;
  let cursor: GeoPoint = request.origin;
  let cursorLabel = originLabel;

  let remainingDistanceKm = totalDistanceKm;
  let pathCoords = coords;
  let pathCumulative = cumulative;
  let guard = 0;
  const maxIterations = Math.max(maxChargingStops, 1);

  const needsStop = () => {
    const rangeCritical = remainingDistanceKm > reachableKm + 0.5;
    const comfortNeeded =
      minChargingStops > 0 &&
      chargingStops.length < minChargingStops &&
      remainingDistanceKm > comfortLegKm * 0.55;
    return rangeCritical || comfortNeeded;
  };

  while (
    needsStop() &&
    chargingStops.length < maxChargingStops &&
    guard < maxIterations
  ) {
    guard += 1;
    const rangeCritical = remainingDistanceKm > reachableKm + 0.5;
    const stopsLeftToMin = Math.max(0, minChargingStops - chargingStops.length);
    const stopsLeftToMax = maxChargingStops - chargingStops.length;

    let interceptKm: number;
    if (rangeCritical) {
      const stretchFactor =
        stopsLeftToMax > 1
          ? Math.min(0.95, 0.55 + 0.1 * stopsLeftToMax)
          : 0.92;
      interceptKm = Math.max(0, Math.min(reachableKm * stretchFactor, remainingDistanceKm * 0.85));
    } else {
      // Comfort spacing: break the remaining trip into remaining min-stops + final leg.
      const chunksLeft = Math.max(1, stopsLeftToMin);
      interceptKm = Math.max(
        5,
        Math.min(comfortLegKm * 0.95, remainingDistanceKm / (chunksLeft + 1)),
      );
    }

    const searchPoint = pointAtDistanceKm(
      pathCoords,
      pathCumulative,
      interceptKm,
    );

    const charger = await selectOptimalCharger({
      lat: searchPoint.lat,
      lng: searchPoint.lng,
      radiusKm: chargerSearchRadiusKm,
      minPowerKw: minChargerPowerKw,
      maxResults: 15,
      excludeIds: usedChargerIds,
    });

    if (!charger) {
      warnings.push(
        `Could not find a fast charger near the next stop point (stop ${chargingStops.length + 1}).`,
      );
      break;
    }

    usedChargerIds.add(charger.id);

    const legToCharger = await fetchMapboxDirections([
      cursor,
      charger.location,
    ]);

    const driveLeg = buildLeg({
      kind: "to_charger",
      from: cursor,
      to: charger.location,
      fromLabel: cursorLabel,
      toLabel: charger.name,
      route: legToCharger,
      socAtStartPercent: currentSoc,
      batteryCapacityKwh: request.batteryCapacityKwh,
      averageWhPerKm,
    });
    legs.push(driveLeg);

    // Estimate next leg length for comfort top-up sizing.
    const provisionalRemaining = await fetchMapboxDirections([
      charger.location,
      request.destination,
    ]);
    const nextPathCum = cumulativeDistancesKm(
      provisionalRemaining.geometry.coordinates,
    );
    const remainingAfterStop = nextPathCum[nextPathCum.length - 1] ?? 0;
    const nextLegKm =
      stopsLeftToMin > 1
        ? Math.min(comfortLegKm, remainingAfterStop / stopsLeftToMin)
        : remainingAfterStop;

    const stopSocTarget = resolveStopSocTarget({
      socAtArrival: driveLeg.socAtEndPercent,
      chargeTargetPercent,
      isRangeCritical: rangeCritical,
      nextLegKm,
      batteryCapacityKwh: request.batteryCapacityKwh,
      averageWhPerKm,
      safetyBufferPercent,
    });

    const chargeMinutes = estimateChargeMinutes({
      capacityKwh: request.batteryCapacityKwh,
      fromSocPercent: driveLeg.socAtEndPercent,
      toSocPercent: stopSocTarget,
      powerKw: charger.powerKw,
    });

    chargingStops.push({
      ...charger,
      estimatedChargeMinutes: chargeMinutes,
    });
    totalChargingMinutes += chargeMinutes;

    currentSoc = stopSocTarget;
    cursor = charger.location;
    cursorLabel = charger.name;

    pathCoords = provisionalRemaining.geometry.coordinates;
    pathCumulative = nextPathCum;
    remainingDistanceKm = remainingAfterStop;

    reachableKm = maxReachableRangeKm({
      socPercent: currentSoc,
      batteryCapacityKwh: request.batteryCapacityKwh,
      averageWhPerKm,
      safetyBufferPercent,
    });
  }

  const needsMoreStops = remainingDistanceKm > reachableKm + 0.5;
  if (needsMoreStops && chargingStops.length >= maxChargingStops) {
    warnings.push(
      `Max ${maxChargingStops} charging stop${maxChargingStops === 1 ? "" : "s"} reached — remaining ~${remainingDistanceKm.toFixed(0)} km may exceed range with a ${safetyBufferPercent}% buffer. Arrival SoC may be low.`,
    );
  } else if (needsMoreStops) {
    warnings.push(
      `Route may exceed remaining range (~${remainingDistanceKm.toFixed(0)} km left, ~${reachableKm.toFixed(0)} km reachable).`,
    );
  }

  if (minChargingStops > 0 && chargingStops.length < minChargingStops) {
    warnings.push(
      `Only placed ${chargingStops.length} of ${minChargingStops} preferred break stops (charger availability or short remaining distance).`,
    );
  } else if (minChargingStops > 0 && chargingStops.length >= minChargingStops) {
    warnings.push(
      `Planned ~${comfortLegKm.toFixed(0)} km legs to honour min ${minChargingStops} break stop${minChargingStops === 1 ? "" : "s"} (kids / pets / shorter drives).`,
    );
  }

  if (
    maxChargingStops > 0 &&
    minChargingStops <= 1 &&
    chargeTargetPercent > DEFAULT_CHARGE_TARGET_PERCENT &&
    chargingStops.length > 0
  ) {
    warnings.push(
      `Charging toward ${chargeTargetPercent}% at range-critical stops to fit within max ${maxChargingStops} stop${maxChargingStops === 1 ? "" : "s"}.`,
    );
  }

  // Final leg to destination.
  const finalRoute = await fetchMapboxDirections([
    cursor,
    request.destination,
  ]);
  const finalLeg = buildLeg({
    kind: "drive",
    from: cursor,
    to: request.destination,
    fromLabel: cursorLabel,
    toLabel: destinationLabel,
    route: finalRoute,
    socAtStartPercent: currentSoc,
    batteryCapacityKwh: request.batteryCapacityKwh,
    averageWhPerKm,
  });
  legs.push(finalLeg);

  const totalDistance = legs.reduce((s, l) => s + l.distanceKm, 0);
  const totalDrivingMinutes = legs.reduce((s, l) => s + l.durationMinutes, 0);
  const withinMaxStops =
    !needsMoreStops && finalLeg.socAtEndPercent >= safetyBufferPercent - 0.5;

  return {
    origin: request.origin,
    destination: request.destination,
    originLabel,
    destinationLabel,
    legs,
    chargingStops,
    totalDistanceKm: Number(totalDistance.toFixed(2)),
    totalDrivingMinutes: Number(totalDrivingMinutes.toFixed(1)),
    totalChargingMinutes,
    arrivalSocPercent: finalLeg.socAtEndPercent,
    departureSocPercent: request.socPercent,
    maxChargingStops,
    minChargingStops,
    withinMaxStops,
    warnings,
    fullGeometry: mergeGeometry(legs),
    plannedAt: new Date().toISOString(),
  };
}
