/**
 * Volvo Cars Developer Portal client.
 * Combines Energy API v2 (SoC / range), Location API v1, and Connected Vehicle API v2
 * into a single normalized {@link VolvoVehicleData} payload.
 *
 * Live base URLs:
 * - https://api.volvocars.com/energy/v2
 * - https://api.volvocars.com/location/v1
 * - https://api.volvocars.com/connected-vehicle/v2
 */

import {
  env,
  isMockMode,
} from "@/lib/config";
import {
  buildMockTelemetry,
  getVolvoModel,
  VOLVO_MODELS,
  type VolvoModelSpec,
} from "@/lib/vehicles";
import type {
  LockStatus,
  PlugStatus,
  VolvoVehicleData,
} from "@/types";

const ENERGY_BASE = "https://api.volvocars.com/energy/v2";
const LOCATION_BASE = "https://api.volvocars.com/location/v1";
const CONNECTED_BASE = "https://api.volvocars.com/connected-vehicle/v2";

export type MockVehicleModel = string;

export { VOLVO_MODELS, getVolvoModel };
export type { VolvoModelSpec };

export class VolvoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly causeDetail?: unknown,
  ) {
    super(message);
    this.name = "VolvoApiError";
  }
}

function hasLiveCredentials(): boolean {
  return Boolean(
    env.volvoVccApiKey &&
      env.volvoAccessToken &&
      env.volvoVin,
  );
}

function volvoHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${env.volvoAccessToken}`,
    "vcc-api-key": env.volvoVccApiKey,
  };

  // Some portal apps also issue a subscription / primary key.
  if (env.volvoPrimaryKey) {
    headers["Ocp-Apim-Subscription-Key"] = env.volvoPrimaryKey;
  }

  return headers;
}

async function volvoGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: volvoHeaders(),
    cache: "no-store",
  });

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new VolvoApiError(
      `Volvo API ${res.status} for ${url}`,
      res.status,
      detail,
    );
  }

  return res.json() as Promise<T>;
}

/** Unwrap common `{ data: T }` envelopes used by Volvo APIs. */
function unwrapData<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data: unknown }).data !== undefined
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
    if (typeof inner === "string" && inner.trim() !== "") {
      const n = Number(inner);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

function normalizeLockStatus(raw: unknown): LockStatus {
  const s = String(raw ?? "").toUpperCase();
  if (s.includes("UNLOCK")) return "UNLOCKED";
  if (s.includes("LOCK")) return "LOCKED";
  return "UNKNOWN";
}

function normalizePlugStatus(raw: unknown): PlugStatus {
  const s = String(raw ?? "").toUpperCase();
  if (
    s.includes("CONNECTED") ||
    s.includes("PLUGGED") ||
    s.includes("CABLE_CONNECTED")
  ) {
    return "CONNECTED";
  }
  if (
    s.includes("DISCONNECTED") ||
    s.includes("UNPLUGGED") ||
    s.includes("NO_CABLE")
  ) {
    return "DISCONNECTED";
  }
  return "UNKNOWN";
}

interface EnergyStateRaw {
  batteryChargeLevel?: unknown;
  electricRange?: unknown;
  chargingConnectionStatus?: unknown;
  chargingSystemStatus?: unknown;
  [key: string]: unknown;
}

interface LocationRaw {
  geometry?: {
    coordinates?: number[];
  };
  latitude?: unknown;
  longitude?: unknown;
  heading?: unknown;
  [key: string]: unknown;
}

interface DoorsRaw {
  carLocked?: unknown;
  centralLock?: unknown;
  [key: string]: unknown;
}

interface VehicleDetailsRaw {
  model?: unknown;
  descriptions?: { model?: unknown; modelYear?: unknown };
  [key: string]: unknown;
}

async function fetchEnergyState(vin: string): Promise<EnergyStateRaw> {
  // Prefer documented energy-state path; fall back to /state if needed.
  try {
    const json = await volvoGet<unknown>(
      `${ENERGY_BASE}/vehicles/${encodeURIComponent(vin)}/energy-state`,
    );
    return unwrapData<EnergyStateRaw>(json);
  } catch (err) {
    if (err instanceof VolvoApiError && err.status === 404) {
      const json = await volvoGet<unknown>(
        `${ENERGY_BASE}/vehicles/${encodeURIComponent(vin)}/state`,
      );
      return unwrapData<EnergyStateRaw>(json);
    }
    throw err;
  }
}

async function fetchLocation(vin: string): Promise<LocationRaw> {
  const json = await volvoGet<unknown>(
    `${LOCATION_BASE}/vehicles/${encodeURIComponent(vin)}/location`,
  );
  return unwrapData<LocationRaw>(json);
}

async function fetchDoors(vin: string): Promise<DoorsRaw | null> {
  try {
    const json = await volvoGet<unknown>(
      `${CONNECTED_BASE}/vehicles/${encodeURIComponent(vin)}/doors`,
    );
    return unwrapData<DoorsRaw>(json);
  } catch {
    return null;
  }
}

async function fetchVehicleDetails(
  vin: string,
): Promise<VehicleDetailsRaw | null> {
  try {
    const json = await volvoGet<unknown>(
      `${CONNECTED_BASE}/vehicles/${encodeURIComponent(vin)}`,
    );
    return unwrapData<VehicleDetailsRaw>(json);
  } catch {
    return null;
  }
}

function extractLatLng(location: LocationRaw): { lat: number; lng: number } {
  const coords = location.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    // GeoJSON order: [lng, lat]
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  const lat = asNumber(location.latitude);
  const lng = asNumber(location.longitude);
  if (lat !== undefined && lng !== undefined) return { lat, lng };

  throw new VolvoApiError("Vehicle location missing coordinates");
}

function inferCapacityKwh(model: string, fallback: number): number {
  const known = VOLVO_MODELS.find((m) =>
    model.toUpperCase().includes(m.id),
  );
  return known?.batteryCapacityKwh ?? fallback;
}

/**
 * Build realistic sandbox telemetry for demos without live vehicle access.
 */
export function getMockTelemetry(modelId: MockVehicleModel = "EX90"): VolvoVehicleData {
  return buildMockTelemetry(modelId);
}

/**
 * Fetch and normalize live vehicle telemetry from Volvo APIs.
 * Throws {@link VolvoApiError} on hard failures (caller may fall back to mock).
 */
export async function fetchLiveTelemetry(
  vin = env.volvoVin,
): Promise<VolvoVehicleData> {
  if (!vin) {
    throw new VolvoApiError("VOLVO_VIN is not configured");
  }
  if (!hasLiveCredentials()) {
    throw new VolvoApiError(
      "Missing Volvo credentials (VOLVO_VCC_API_KEY, VOLVO_ACCESS_TOKEN, VOLVO_VIN)",
    );
  }

  const [energy, location, doors, details] = await Promise.all([
    fetchEnergyState(vin),
    fetchLocation(vin),
    fetchDoors(vin),
    fetchVehicleDetails(vin),
  ]);

  const socPercent = asNumber(energy.batteryChargeLevel);
  const remainingRangeKm = asNumber(energy.electricRange);
  const { lat, lng } = extractLatLng(location);

  const model =
    asString(details?.descriptions?.model) ||
    asString(details?.model) ||
    "Volvo EV";

  const lockStatus = normalizeLockStatus(
    doors?.carLocked ?? doors?.centralLock,
  );
  const plugStatus = normalizePlugStatus(
    energy.chargingConnectionStatus ?? energy.chargingSystemStatus,
  );

  if (socPercent === undefined) {
    throw new VolvoApiError("Energy state missing batteryChargeLevel");
  }

  return {
    vin,
    model,
    socPercent: Math.min(100, Math.max(0, socPercent)),
    batteryCapacityKwh: inferCapacityKwh(model, getVolvoModel("EX90").batteryCapacityKwh),
    remainingRangeKm: remainingRangeKm ?? Math.round(socPercent * 4.5),
    location: { lat, lng },
    lockStatus,
    plugStatus,
    timestamp: new Date().toISOString(),
    source: "live",
  };
}

export interface GetVehicleTelemetryOptions {
  /** Force mock even when credentials exist. */
  forceMock?: boolean;
  mockModel?: MockVehicleModel;
  /**
   * When live fetch fails, return mock instead of throwing.
   * Defaults to true so the planner stays usable offline.
   */
  fallbackToMock?: boolean;
}

/**
 * Primary entry point used by API routes / server actions.
 * Honours MOCK_MODE and automatically falls back when keys or hardware are absent.
 */
export async function getVehicleTelemetry(
  options: GetVehicleTelemetryOptions = {},
): Promise<VolvoVehicleData> {
  const {
    forceMock = false,
    mockModel = "EX90",
    fallbackToMock = true,
  } = options;

  if (forceMock || isMockMode() || !hasLiveCredentials()) {
    return getMockTelemetry(mockModel);
  }

  try {
    return await fetchLiveTelemetry();
  } catch (err) {
    if (!fallbackToMock) throw err;
    console.warn(
      "[volvoApi] Live telemetry failed — using mock sandbox:",
      err instanceof Error ? err.message : err,
    );
    return getMockTelemetry(mockModel);
  }
}
