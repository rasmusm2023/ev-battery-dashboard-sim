/**
 * Volvo EV model catalog for mock telemetry + range planning.
 */

import { DEFAULT_WH_PER_KM } from "@/lib/config";
import type { GeoPoint, VolvoVehicleData } from "@/types";

export interface VolvoModelSpec {
  id: string;
  name: string;
  /** Usable pack capacity (kWh). */
  batteryCapacityKwh: number;
  /** Default average consumption (Wh/km). */
  averageWhPerKm: number;
  /** Starting SoC for sandbox demos. */
  defaultSocPercent: number;
  /** Default garage / start position. */
  homeLocation: GeoPoint;
}

export const VOLVO_MODELS: VolvoModelSpec[] = [
  {
    id: "EX30",
    name: "EX30",
    batteryCapacityKwh: 69,
    averageWhPerKm: 165,
    defaultSocPercent: 45,
    homeLocation: { lat: 57.7089, lng: 11.9746 },
  },
  {
    id: "EX40",
    name: "EX40",
    batteryCapacityKwh: 82,
    averageWhPerKm: 180,
    defaultSocPercent: 40,
    homeLocation: { lat: 57.7089, lng: 11.9746 },
  },
  {
    id: "EC40",
    name: "EC40",
    batteryCapacityKwh: 82,
    averageWhPerKm: 175,
    defaultSocPercent: 42,
    homeLocation: { lat: 57.7089, lng: 11.9746 },
  },
  {
    id: "EX90",
    name: "EX90",
    batteryCapacityKwh: 107,
    averageWhPerKm: 210,
    defaultSocPercent: 35,
    homeLocation: { lat: 57.7089, lng: 11.9746 },
  },
];

export function getVolvoModel(id: string): VolvoModelSpec {
  return VOLVO_MODELS.find((m) => m.id === id) ?? VOLVO_MODELS[3];
}

/** Estimated remaining range from SoC + model consumption. */
export function estimateRangeKm(
  socPercent: number,
  capacityKwh: number,
  averageWhPerKm = DEFAULT_WH_PER_KM,
): number {
  const usableKwh =
    capacityKwh * (Math.max(0, Math.min(100, socPercent)) / 100);
  return Math.round((usableKwh * 1000) / Math.max(averageWhPerKm, 1));
}

export function buildMockTelemetry(
  modelId: string,
  overrides: Partial<Pick<VolvoVehicleData, "socPercent" | "location" | "lockStatus" | "plugStatus">> = {},
): VolvoVehicleData {
  const model = getVolvoModel(modelId);
  const socPercent = overrides.socPercent ?? model.defaultSocPercent;
  const location = overrides.location ?? { ...model.homeLocation };

  return {
    vin: `YV1MOCK${model.id}000001`,
    model: model.name,
    socPercent,
    batteryCapacityKwh: model.batteryCapacityKwh,
    remainingRangeKm: estimateRangeKm(
      socPercent,
      model.batteryCapacityKwh,
      model.averageWhPerKm,
    ),
    location,
    lockStatus: overrides.lockStatus ?? "LOCKED",
    plugStatus: overrides.plugStatus ?? "DISCONNECTED",
    timestamp: new Date().toISOString(),
    source: "mock",
  };
}
