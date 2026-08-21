/**
 * Client-side drive simulation timeline.
 * Timing: 1s per 10 km driven, 1s per 10% SoC charged.
 */

import type { EVRouteResult, GeoPoint } from "@/types";

export type VehicleSimStatus =
  | "off"
  | "idle"
  | "driving"
  | "charging"
  | "arrived";

export type LngLat = [number, number];

export interface DriveSegment {
  type: "drive";
  coordinates: LngLat[];
  distanceKm: number;
  durationMs: number;
  socStart: number;
  socEnd: number;
}

export interface ChargeSegment {
  type: "charge";
  location: GeoPoint;
  durationMs: number;
  socStart: number;
  socEnd: number;
  stationName: string;
  powerKw: number;
  /** How many SoC points still needed at segment start (for UI). */
  chargeNeededPercent: number;
}

export type SimSegment = DriveSegment | ChargeSegment;

export interface SimFrame {
  status: VehicleSimStatus;
  location: GeoPoint;
  socPercent: number;
  segmentIndex: number;
  /** Remaining % to charge when status === charging */
  chargeRemainingPercent?: number;
  chargeTargetPercent?: number;
  chargeStationName?: string;
  progress: number; // 0–1 overall
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

function driveDurationMs(distanceKm: number): number {
  return (distanceKm / 10) * 1000;
}

function chargeDurationMs(deltaSocPercent: number): number {
  return (Math.max(0, deltaSocPercent) / 10) * 1000;
}

function densifyIfNeeded(coords: LngLat[]): LngLat[] {
  if (coords.length >= 2) return coords;
  if (coords.length === 1) return [coords[0], coords[0]];
  return [
    [0, 0],
    [0, 0],
  ];
}

function pointAlongLine(coords: LngLat[], fraction: number): GeoPoint {
  const line = densifyIfNeeded(coords);
  const t = Math.min(1, Math.max(0, fraction));
  const cum = [0];
  for (let i = 1; i < line.length; i++) {
    cum.push(
      cum[i - 1] +
        haversineKm(
          { lng: line[i - 1][0], lat: line[i - 1][1] },
          { lng: line[i][0], lat: line[i][1] },
        ),
    );
  }
  const total = cum[cum.length - 1] || 0;
  if (total <= 0) {
    return { lng: line[0][0], lat: line[0][1] };
  }
  const target = total * t;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= target) {
      const seg = Math.max(cum[i] - cum[i - 1], 1e-9);
      const u = (target - cum[i - 1]) / seg;
      const a = line[i - 1];
      const b = line[i];
      return {
        lng: a[0] + (b[0] - a[0]) * u,
        lat: a[1] + (b[1] - a[1]) * u,
      };
    }
  }
  const last = line[line.length - 1];
  return { lng: last[0], lat: last[1] };
}

/** Build ordered drive/charge segments from a planned EV route. */
export function buildSimSegments(route: EVRouteResult): SimSegment[] {
  const segments: SimSegment[] = [];
  let chargeStopIndex = 0;

  for (let legIndex = 0; legIndex < route.legs.length; legIndex++) {
    const leg = route.legs[legIndex];
    const coords = densifyIfNeeded(leg.geometry.coordinates);
    segments.push({
      type: "drive",
      coordinates: coords,
      distanceKm: leg.distanceKm,
      durationMs: Math.max(50, driveDurationMs(leg.distanceKm)),
      socStart: leg.socAtStartPercent,
      socEnd: leg.socAtEndPercent,
    });

    if (leg.kind === "to_charger") {
      const stop = route.chargingStops[chargeStopIndex++];
      const nextLeg = route.legs[legIndex + 1];
      const socStart = leg.socAtEndPercent;
      const socEnd = nextLeg?.socAtStartPercent ?? Math.max(socStart, 80);
      const needed = Math.max(0, socEnd - socStart);

      segments.push({
        type: "charge",
        location: stop?.location ?? leg.to,
        durationMs: Math.max(50, chargeDurationMs(needed)),
        socStart,
        socEnd,
        stationName: stop?.name ?? leg.toLabel,
        powerKw: stop?.powerKw ?? 150,
        chargeNeededPercent: needed,
      });
    }
  }

  return segments;
}

export function totalSimDurationMs(segments: SimSegment[]): number {
  return segments.reduce((s, seg) => s + seg.durationMs, 0);
}

export function sampleSim(
  segments: SimSegment[],
  elapsedMs: number,
): SimFrame {
  if (segments.length === 0) {
    return {
      status: "arrived",
      location: { lat: 0, lng: 0 },
      socPercent: 0,
      segmentIndex: 0,
      progress: 1,
    };
  }

  const total = totalSimDurationMs(segments);
  if (elapsedMs >= total) {
    const last = segments[segments.length - 1];
    const location =
      last.type === "drive"
        ? pointAlongLine(last.coordinates, 1)
        : last.location;
    return {
      status: "arrived",
      location,
      socPercent: last.socEnd,
      segmentIndex: segments.length - 1,
      progress: 1,
    };
  }

  let t = Math.max(0, elapsedMs);
  let acc = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (t <= acc + seg.durationMs) {
      const local = Math.min(seg.durationMs, Math.max(0, t - acc));
      const f = seg.durationMs > 0 ? local / seg.durationMs : 1;

      if (seg.type === "drive") {
        const location = pointAlongLine(seg.coordinates, f);
        const soc = seg.socStart + (seg.socEnd - seg.socStart) * f;
        return {
          status: "driving",
          location,
          socPercent: Number(soc.toFixed(1)),
          segmentIndex: i,
          progress: total > 0 ? Math.min(1, t / total) : 1,
        };
      }

      const soc = seg.socStart + (seg.socEnd - seg.socStart) * f;
      const remaining = Math.max(0, seg.socEnd - soc);
      return {
        status: "charging",
        location: seg.location,
        socPercent: Number(soc.toFixed(1)),
        segmentIndex: i,
        chargeRemainingPercent: Number(remaining.toFixed(1)),
        chargeTargetPercent: seg.socEnd,
        chargeStationName: seg.stationName,
        progress: total > 0 ? Math.min(1, t / total) : 1,
      };
    }
    acc += seg.durationMs;
  }

  const last = segments[segments.length - 1];
  const location =
    last.type === "drive"
      ? pointAlongLine(last.coordinates, 1)
      : last.location;
  return {
    status: "arrived",
    location,
    socPercent: last.socEnd,
    segmentIndex: segments.length - 1,
    progress: 1,
  };
}
