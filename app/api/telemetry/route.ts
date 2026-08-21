import { getVehicleTelemetry, VOLVO_MODELS } from "@/lib/volvoApi";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/telemetry
 * Returns normalized Volvo vehicle telemetry (live or MOCK_MODE sandbox).
 *
 * Query:
 * - model=EX30|EX40|EC40|EX90 — mock model preference (default EX90)
 * - forceMock=1 — always use sandbox
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const modelParam = searchParams.get("model") ?? "EX90";
  const known = VOLVO_MODELS.some((m) => m.id === modelParam);
  const mockModel = known ? modelParam : "EX90";
  const forceMock = ["1", "true", "yes"].includes(
    (searchParams.get("forceMock") ?? "").toLowerCase(),
  );

  try {
    const telemetry = await getVehicleTelemetry({ mockModel, forceMock });
    return NextResponse.json(telemetry);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Telemetry failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
