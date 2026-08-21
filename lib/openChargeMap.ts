/**
 * Open Charge Map client for DC fast-charger discovery along EV routes.
 * @see https://api.openchargemap.io/v3/poi/
 */

import {
  DEFAULT_CHARGER_SEARCH_RADIUS_KM,
  DEFAULT_MIN_CHARGER_POWER_KW,
  env,
} from "@/lib/config";
import type { ChargingStation, GeoPoint } from "@/types";

const OCM_POI_URL = "https://api.openchargemap.io/v3/poi/";

/** OCM ConnectionTypeID for IEC 62196 CCS Combo 2 (EU). */
const CCS_COMBO_2_TYPE_ID = 33;

export interface NearbyChargersQuery {
  lat: number;
  lng: number;
  /** Search radius in kilometres (default 25). */
  radiusKm?: number;
  /** Minimum connector power in kW (default 50). */
  minPowerKw?: number;
  /** Max POIs to return after filtering/sorting (default 10). */
  maxResults?: number;
  /** Prefer CCS2 connectors when true (default true). */
  preferCcs2?: boolean;
}

export class OpenChargeMapError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenChargeMapError";
  }
}

interface OcmConnection {
  ConnectionTypeID?: number;
  ConnectionType?: { Title?: string; FormalName?: string };
  PowerKW?: number | null;
  Quantity?: number | null;
  LevelID?: number | null;
}

interface OcmAddressInfo {
  Title?: string;
  Town?: string;
  Latitude?: number;
  Longitude?: number;
  Distance?: number;
}

interface OcmPoi {
  ID?: number;
  UUID?: string;
  AddressInfo?: OcmAddressInfo;
  Connections?: OcmConnection[];
  OperatorInfo?: { Title?: string };
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

function connectionLabel(c: OcmConnection): string {
  return (
    c.ConnectionType?.Title ||
    c.ConnectionType?.FormalName ||
    (c.ConnectionTypeID === CCS_COMBO_2_TYPE_ID ? "CCS" : "Unknown")
  );
}

function peakPowerKw(connections: OcmConnection[] | undefined): number {
  if (!connections?.length) return 0;
  return connections.reduce((max, c) => {
    const p = typeof c.PowerKW === "number" ? c.PowerKW : 0;
    return Math.max(max, p);
  }, 0);
}

/** Level-3 / CCS with missing PowerKW still count as fast-capable. */
function effectivePowerKw(
  connections: OcmConnection[] | undefined,
  minPowerKw: number,
): number {
  const peak = peakPowerKw(connections);
  if (peak > 0) return peak;

  const level3 = connections?.some((c) => c.LevelID === 3);
  const ccs = hasCcs2(connections);
  if (level3 || ccs) return Math.max(minPowerKw, 50);
  return 0;
}

function connectorTypes(connections: OcmConnection[] | undefined): string[] {
  if (!connections?.length) return [];
  const labels = connections.map(connectionLabel).filter(Boolean);
  return [...new Set(labels)];
}

function hasCcs2(connections: OcmConnection[] | undefined): boolean {
  if (!connections?.length) return false;
  return connections.some(
    (c) =>
      c.ConnectionTypeID === CCS_COMBO_2_TYPE_ID ||
      /ccs/i.test(connectionLabel(c)),
  );
}

function mapPoi(
  poi: OcmPoi,
  origin: GeoPoint,
  minPowerKw: number,
  preferCcs2: boolean,
): ChargingStation | null {
  const lat = poi.AddressInfo?.Latitude;
  const lng = poi.AddressInfo?.Longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  const connections = poi.Connections ?? [];
  const powerKw = effectivePowerKw(connections, minPowerKw);
  if (powerKw < minPowerKw) return null;
  if (preferCcs2 && connections.length > 0 && !hasCcs2(connections)) {
    // Keep stations with unknown connectors if they meet power via Level 3.
    const level3 = connections.some((c) => c.LevelID === 3);
    if (!level3) return null;
  }

  const location = { lat, lng };
  const distanceFromRouteKm =
    typeof poi.AddressInfo?.Distance === "number"
      ? poi.AddressInfo.Distance
      : haversineKm(origin, location);

  return {
    id: String(poi.UUID ?? poi.ID ?? `${lat.toFixed(5)},${lng.toFixed(5)}`),
    name: poi.AddressInfo?.Title || "EV charger",
    location,
    town: poi.AddressInfo?.Town || undefined,
    powerKw,
    connectorTypes: connectorTypes(connections),
    operatorName: poi.OperatorInfo?.Title || undefined,
    distanceFromRouteKm: Number(distanceFromRouteKm.toFixed(2)),
  };
}

/**
 * Local synthetic fast charger near the search point (route-aware fallback).
 * Used only when OCM returns nothing — never jumps back to a fixed city.
 */
function syntheticChargersNear(origin: GeoPoint): ChargingStation[] {
  const offsets = [
    { dLat: 0.04, dLng: 0.03, name: "Route DC Hub A", power: 150 },
    { dLat: -0.03, dLng: 0.05, name: "Route DC Hub B", power: 120 },
    { dLat: 0.02, dLng: -0.04, name: "Route DC Hub C", power: 100 },
  ];

  return offsets.map((o, i) => {
    const location = {
      lat: origin.lat + o.dLat,
      lng: origin.lng + o.dLng,
    };
    return {
      id: `synthetic-${origin.lat.toFixed(3)}-${origin.lng.toFixed(3)}-${i}`,
      name: o.name,
      location,
      town: "Along route",
      powerKw: o.power,
      connectorTypes: ["CCS"],
      operatorName: "Synthetic (OCM unavailable)",
      distanceFromRouteKm: Number(haversineKm(origin, location).toFixed(2)),
    };
  });
}

async function fetchOcm(
  origin: GeoPoint,
  radiusKm: number,
  maxResults: number,
  preferCcs2: boolean,
): Promise<OcmPoi[]> {
  const params = new URLSearchParams({
    output: "json",
    latitude: String(origin.lat),
    longitude: String(origin.lng),
    distance: String(radiusKm),
    distanceunit: "KM",
    maxresults: String(Math.max(maxResults * 4, 40)),
    compact: "false",
    verbose: "false",
  });

  // Prefer DC fast (Level 3). Avoid over-filtering by connection type on first pass.
  params.set("levelid", "3");
  if (preferCcs2) {
    params.set("connectiontypeid", String(CCS_COMBO_2_TYPE_ID));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "SmartEVRoutePlanner/0.1",
  };

  if (env.openChargeMapKey) {
    headers["X-API-Key"] = env.openChargeMapKey;
    params.set("key", env.openChargeMapKey);
  }

  const res = await fetch(`${OCM_POI_URL}?${params.toString()}`, {
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new OpenChargeMapError(
      `Open Charge Map returned ${res.status}`,
      res.status,
    );
  }

  const data = (await res.json()) as OcmPoi[];
  return Array.isArray(data) ? data : [];
}

/**
 * Estimate DC charge duration (minutes) using a simple average-power model.
 * Assumes taper so effective power ≈ 70% of peak nameplate near higher SoC.
 */
export function estimateChargeMinutes(options: {
  capacityKwh: number;
  fromSocPercent: number;
  toSocPercent: number;
  powerKw: number;
}): number {
  const { capacityKwh, fromSocPercent, toSocPercent, powerKw } = options;
  const deltaSoc = Math.max(0, toSocPercent - fromSocPercent);
  if (deltaSoc === 0 || powerKw <= 0) return 0;

  const energyKwh = capacityKwh * (deltaSoc / 100);
  const effectiveKw = powerKw * 0.7;
  return Math.max(1, Math.round((energyKwh / effectiveKw) * 60));
}

/**
 * Query Open Charge Map for nearby fast chargers along the route search point.
 * Falls back to synthetic hubs near that point (not a fixed city).
 */
export async function getNearbyFastChargers(
  query: NearbyChargersQuery,
): Promise<ChargingStation[]> {
  const {
    lat,
    lng,
    radiusKm = DEFAULT_CHARGER_SEARCH_RADIUS_KM,
    minPowerKw = DEFAULT_MIN_CHARGER_POWER_KW,
    maxResults = 10,
    preferCcs2 = true,
  } = query;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new OpenChargeMapError("lat and lng must be finite numbers");
  }

  const origin: GeoPoint = { lat, lng };

  try {
    let data = await fetchOcm(origin, radiusKm, maxResults, preferCcs2);

    // Broaden search if CCS filter was too strict.
    if (data.length === 0 && preferCcs2) {
      data = await fetchOcm(origin, radiusKm, maxResults, false);
    }

    // Expand radius once if still empty.
    if (data.length === 0 && radiusKm < 80) {
      data = await fetchOcm(origin, Math.min(80, radiusKm * 2), maxResults, false);
    }

    const mapped = data
      .map((poi) => mapPoi(poi, origin, minPowerKw, false))
      .filter((s): s is ChargingStation => s !== null)
      .sort(
        (a, b) =>
          (a.distanceFromRouteKm ?? Infinity) -
          (b.distanceFromRouteKm ?? Infinity),
      );

    if (mapped.length === 0) {
      console.warn(
        "[openChargeMap] No POIs matched filters — using route-local synthetic hubs",
        { lat, lng, radiusKm },
      );
      return syntheticChargersNear(origin).slice(0, maxResults);
    }

    return mapped.slice(0, maxResults);
  } catch (err) {
    console.warn(
      "[openChargeMap] API error — using route-local synthetic hubs:",
      err instanceof Error ? err.message : err,
    );
    return syntheticChargersNear(origin).slice(0, maxResults);
  }
}

/**
 * Pick the single best station: closest to the search point with highest power as tie-break.
 * Pass `excludeIds` to skip chargers already used earlier on the same journey.
 */
export async function selectOptimalCharger(
  query: NearbyChargersQuery & { excludeIds?: Iterable<string> },
): Promise<ChargingStation | null> {
  const excluded = new Set(query.excludeIds ?? []);
  const stations = await getNearbyFastChargers({
    ...query,
    maxResults: query.maxResults ?? 15,
  });

  const candidates = stations.filter((s) => !excluded.has(s.id));
  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    const d =
      (a.distanceFromRouteKm ?? Infinity) - (b.distanceFromRouteKm ?? Infinity);
    if (Math.abs(d) > 0.5) return d;
    return b.powerKw - a.powerKw;
  })[0];
}
