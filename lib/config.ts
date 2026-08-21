/**
 * Environment + mock telemetry defaults for the Smart EV Route Planner.
 * Server modules should import from here instead of reading process.env ad hoc.
 */

import type { VolvoVehicleData } from "@/types";

function readFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** True when live Volvo hardware/keys are unavailable or explicitly mocked. */
export function isMockMode(): boolean {
  return readFlag(process.env.MOCK_MODE, true);
}

export const env = {
  get mockMode() {
    return isMockMode();
  },
  get volvoPrimaryKey() {
    return process.env.VOLVO_PRIMARY_KEY ?? "";
  },
  get volvoVccApiKey() {
    return process.env.VOLVO_VCC_API_KEY ?? "";
  },
  get volvoAccessToken() {
    return process.env.VOLVO_ACCESS_TOKEN ?? "";
  },
  get volvoVin() {
    return process.env.VOLVO_VIN ?? "";
  },
  get mapboxToken() {
    return (
      process.env.MAPBOX_ACCESS_TOKEN ||
      process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
      ""
    );
  },
  get mapboxPublicToken() {
    return process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
  },
  get openChargeMapKey() {
    return process.env.OPEN_CHARGE_MAP_KEY ?? "";
  },
} as const;

/** Realistic EX30-class mock used when MOCK_MODE=true. */
export const MOCK_EX30_TELEMETRY: VolvoVehicleData = {
  vin: "YV1MOCKEX30000001",
  model: "EX30",
  socPercent: 35,
  batteryCapacityKwh: 69, // usable approx. for EX30 Single Motor Extended Range class
  remainingRangeKm: 145,
  location: {
    lat: 57.7089,
    lng: 11.9746, // Göteborg
  },
  lockStatus: "LOCKED",
  plugStatus: "DISCONNECTED",
  timestamp: new Date().toISOString(),
  source: "mock",
};

/** Alternate EX90-class mock (higher capacity) for demos. */
export const MOCK_EX90_TELEMETRY: VolvoVehicleData = {
  vin: "YV1MOCKEX90000001",
  model: "EX90",
  socPercent: 35,
  batteryCapacityKwh: 82,
  remainingRangeKm: 210,
  location: {
    lat: 57.7089,
    lng: 11.9746,
  },
  lockStatus: "LOCKED",
  plugStatus: "DISCONNECTED",
  timestamp: new Date().toISOString(),
  source: "mock",
};

/** Default average energy use for range / stop insertion (Wh/km). */
export const DEFAULT_WH_PER_KM = 180;

/** Keep at least this SoC in reserve when deciding charger waypoints. */
export const DEFAULT_SAFETY_BUFFER_PERCENT = 15;

/** Assume chargers top the pack up to this SoC before the next leg. */
export const DEFAULT_CHARGE_TARGET_PERCENT = 80;

/** Prefer CCS2 DC fast chargers at or above this power. */
export const DEFAULT_MIN_CHARGER_POWER_KW = 50;

/** OCM search radius around the low-SoC intercept point. */
export const DEFAULT_CHARGER_SEARCH_RADIUS_KM = 25;

/** Default cap on inserted charging stops. */
export const DEFAULT_MAX_CHARGING_STOPS = 3;

/** Default minimum comfort stops (0 = range-driven only). */
export const DEFAULT_MIN_CHARGING_STOPS = 0;
