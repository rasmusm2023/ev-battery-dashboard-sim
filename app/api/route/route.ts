import { planEvRoute } from "@/lib/evRouting";
import type { EVRoutePlanRequest, GeoPoint } from "@/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/route
 * Body: {@link EVRoutePlanRequest}
 * Plans a driving route with dynamic EV charging stops.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parsePlanRequest(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await planEvRoute(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Route planning failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function parsePlanRequest(
  body: unknown,
): EVRoutePlanRequest | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Body must be an object" };
  }

  const b = body as Record<string, unknown>;
  const origin = parsePoint(b.origin);
  const destination = parsePoint(b.destination);

  if (!origin) return { error: "origin { lat, lng } is required" };
  if (!destination) return { error: "destination { lat, lng } is required" };

  const socPercent = Number(b.socPercent);
  const batteryCapacityKwh = Number(b.batteryCapacityKwh);

  if (!Number.isFinite(socPercent) || socPercent < 0 || socPercent > 100) {
    return { error: "socPercent must be a number between 0 and 100" };
  }
  if (!Number.isFinite(batteryCapacityKwh) || batteryCapacityKwh <= 0) {
    return { error: "batteryCapacityKwh must be a positive number" };
  }

  return {
    origin,
    destination,
    originLabel: optionalString(b.originLabel),
    destinationLabel: optionalString(b.destinationLabel),
    socPercent,
    batteryCapacityKwh,
    averageWhPerKm: optionalNumber(b.averageWhPerKm),
    safetyBufferPercent: optionalNumber(b.safetyBufferPercent),
    chargeTargetPercent: optionalNumber(b.chargeTargetPercent),
    minChargingStops: optionalNumber(b.minChargingStops),
    maxChargingStops: optionalNumber(b.maxChargingStops),
    minChargerPowerKw: optionalNumber(b.minChargerPowerKw),
    chargerSearchRadiusKm: optionalNumber(b.chargerSearchRadiusKm),
  };
}

function parsePoint(value: unknown): GeoPoint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
