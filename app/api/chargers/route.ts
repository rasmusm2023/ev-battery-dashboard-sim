import { getNearbyFastChargers } from "@/lib/openChargeMap";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/chargers?lat=&lng=&radiusKm=&minPowerKw=&maxResults=
 * Nearby CCS2 fast chargers from Open Charge Map (with demo fallback).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: "Query params lat and lng are required numbers" },
      { status: 400 },
    );
  }

  const radiusKm = optionalNumber(searchParams.get("radiusKm"));
  const minPowerKw = optionalNumber(searchParams.get("minPowerKw"));
  const maxResults = optionalNumber(searchParams.get("maxResults"));

  try {
    const chargers = await getNearbyFastChargers({
      lat,
      lng,
      radiusKm,
      minPowerKw,
      maxResults,
    });
    return NextResponse.json({
      count: chargers.length,
      chargers,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Charger lookup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
