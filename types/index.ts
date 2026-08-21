/**
 * Shared domain types for the Smart EV Route Planner.
 * Used by Volvo telemetry, Open Charge Map, Mapbox routing, and UI.
 */

/** WGS84 coordinate pair used across Mapbox / OCM / Volvo location payloads. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Door / security lock state from Connected Vehicle API (normalized). */
export type LockStatus = "LOCKED" | "UNLOCKED" | "UNKNOWN";

/** Charge plug connection state (normalized). */
export type PlugStatus = "CONNECTED" | "DISCONNECTED" | "UNKNOWN";

/**
 * Normalized vehicle telemetry for dashboard + routing.
 * Populated from Volvo Connected Vehicle / Energy APIs, or MOCK_MODE.
 */
export interface VolvoVehicleData {
  /** Vehicle identification number (may be masked in mock mode). */
  vin: string;
  /** Marketing model name, e.g. "EX30" / "EX90". */
  model: string;
  /** State of Charge as percentage 0–100. */
  socPercent: number;
  /** Usable battery pack capacity in kWh. */
  batteryCapacityKwh: number;
  /** OEM estimated remaining electric range in km. */
  remainingRangeKm: number;
  /** Last known vehicle position. */
  location: GeoPoint;
  lockStatus: LockStatus;
  plugStatus: PlugStatus;
  /** ISO-8601 timestamp of the telemetry sample. */
  timestamp: string;
  /** Whether values came from live Volvo APIs or the sandbox mock. */
  source: "live" | "mock";
}

/**
 * Fast-charging POI selected / displayed along a planned route.
 * Sourced primarily from Open Charge Map.
 */
export interface ChargingStation {
  id: string;
  name: string;
  location: GeoPoint;
  /** Locality / town when provided by OCM. */
  town?: string;
  /** Peak connector power in kW (prefer CCS2 ≥ 50 kW). */
  powerKw: number;
  /** Connector type labels, e.g. ["CCS", "Type 2"]. */
  connectorTypes: string[];
  /** Network / operator name when available. */
  operatorName?: string;
  /** Straight-line or route-offset distance used during selection. */
  distanceFromRouteKm?: number;
  /** Estimated minutes to charge to the configured target SoC (e.g. 80%). */
  estimatedChargeMinutes?: number;
}

/** One continuous driving segment between waypoints. */
export type RouteLegKind = "drive" | "to_charger";

export interface RouteLeg {
  kind: RouteLegKind;
  from: GeoPoint;
  to: GeoPoint;
  /** Label for UI (origin name, charger name, destination). */
  fromLabel: string;
  toLabel: string;
  distanceKm: number;
  durationMinutes: number;
  /**
   * Encoded or decoded route geometry for Mapbox layers.
   * Coordinates are [lng, lat] per GeoJSON convention.
   */
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
  /** Predicted SoC (%) at the start of this leg. */
  socAtStartPercent: number;
  /** Predicted SoC (%) at the end of this leg (before any charge). */
  socAtEndPercent: number;
}

/**
 * Full planned journey: driving legs, inserted charge stops, and trip totals.
 */
export interface EVRouteResult {
  origin: GeoPoint;
  destination: GeoPoint;
  originLabel: string;
  destinationLabel: string;
  legs: RouteLeg[];
  chargingStops: ChargingStation[];
  totalDistanceKm: number;
  totalDrivingMinutes: number;
  totalChargingMinutes: number;
  /** Predicted remaining SoC (%) when arriving at destination. */
  arrivalSocPercent: number;
  /** Starting SoC used for the plan. */
  departureSocPercent: number;
  /** Max charging stops the planner was allowed to insert. */
  maxChargingStops: number;
  /** Minimum comfort / break stops requested by the user. */
  minChargingStops: number;
  /** True when the trip fits within maxChargingStops without draining past the buffer. */
  withinMaxStops: boolean;
  /** Human-readable planning notes (e.g. stop cap reached). */
  warnings: string[];
  /**
   * Combined route polyline for a single map layer if needed.
   * Coordinates are [lng, lat].
   */
  fullGeometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
  /** ISO-8601 when the plan was computed. */
  plannedAt: string;
}

/** Input payload for the EV range + charger insertion algorithm. */
export interface EVRoutePlanRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  originLabel?: string;
  destinationLabel?: string;
  socPercent: number;
  batteryCapacityKwh: number;
  /** Average consumption in Wh/km (default ~180). */
  averageWhPerKm?: number;
  /** Minimum SoC retained as safety buffer (default 15). */
  safetyBufferPercent?: number;
  /** Target SoC after a charging stop (default 80). */
  chargeTargetPercent?: number;
  /** Minimum charging/break stops to insert even if range would allow fewer (default 0). */
  minChargingStops?: number;
  /** Maximum number of charging stops to insert (default 3, 0 = none). */
  maxChargingStops?: number;
  /** Minimum charger power in kW (default 50, CCS2 fast charge). */
  minChargerPowerKw?: number;
  /** Charger search radius in km (default 25). */
  chargerSearchRadiusKm?: number;
}

/** Mapbox Geocoding suggestion for origin/destination search UI. */
export interface GeocodingFeature {
  id: string;
  placeName: string;
  location: GeoPoint;
}
