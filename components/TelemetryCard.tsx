"use client";

import type { VehicleSimStatus } from "@/lib/driveSimulation";
import type { VolvoVehicleData } from "@/types";

export interface TelemetryCardProps {
  data: VolvoVehicleData | null;
  loading?: boolean;
  error?: string | null;
  carOn?: boolean;
  simStatus?: VehicleSimStatus;
  onRefresh?: () => void;
}

function socTone(soc: number): string {
  if (soc < 20) return "text-[#dc3d3d]";
  if (soc < 40) return "text-[#d97706]";
  return "text-[#1a9f6e]";
}

function socBar(soc: number): string {
  if (soc < 20) return "bg-[#dc3d3d]";
  if (soc < 40) return "bg-[#d97706]";
  return "bg-[#1a9f6e]";
}

/**
 * Live / mock Volvo EV status for the planner sidebar.
 */
export function TelemetryCard({
  data,
  loading,
  error,
  carOn,
  simStatus = "off",
  onRefresh,
}: TelemetryCardProps) {
  return (
    <section className="rounded-2xl border border-black/10 bg-white/75 p-4 shadow-sm backdrop-blur">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[#5c6670]">
            Vehicle telemetry
          </p>
          <h2 className="text-lg font-semibold text-[#12151a]">
            {data ? `Volvo ${data.model}` : "Volvo EV"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={
            loading || simStatus === "driving" || simStatus === "charging"
          }
          className="rounded-lg border border-black/10 px-2.5 py-1.5 text-xs font-semibold text-[#12151a] transition hover:bg-white disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#5c6670]">
        Status:{" "}
        <span className="text-[#12151a]">
          {!carOn
            ? "OFF"
            : simStatus === "charging"
              ? "CHARGING"
              : simStatus === "driving"
                ? "DRIVING"
                : simStatus === "arrived"
                  ? "ARRIVED"
                  : "IDLE"}
        </span>
      </p>

      {error && (
        <p className="mb-3 rounded-lg bg-[#dc3d3d]/10 px-3 py-2 text-sm text-[#dc3d3d]">
          {error}
        </p>
      )}

      {!data && !error && (
        <p className="text-sm text-[#5c6670]">
          {loading ? "Fetching telemetry…" : "No telemetry yet."}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-[#5c6670]">
                State of Charge
              </span>
              <span
                className={`font-mono text-2xl font-medium ${socTone(data.socPercent)}`}
              >
                {Math.round(data.socPercent)}
                <span className="text-sm text-[#5c6670]">%</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-black/10">
              <div
                className={`h-full rounded-full transition-all duration-150 ${socBar(data.socPercent)}`}
                style={{
                  width: `${Math.min(100, Math.max(0, data.socPercent))}%`,
                }}
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-black/[0.03] p-3">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[#5c6670]">
                Range
              </dt>
              <dd className="font-mono text-lg font-medium text-[#12151a]">
                {data.remainingRangeKm}
                <span className="text-xs text-[#5c6670]"> km</span>
              </dd>
            </div>
            <div className="rounded-xl bg-black/[0.03] p-3">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[#5c6670]">
                Capacity
              </dt>
              <dd className="font-mono text-lg font-medium text-[#12151a]">
                {data.batteryCapacityKwh}
                <span className="text-xs text-[#5c6670]"> kWh</span>
              </dd>
            </div>
            <div className="rounded-xl bg-black/[0.03] p-3">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[#5c6670]">
                Lock
              </dt>
              <dd className="font-medium text-[#12151a]">{data.lockStatus}</dd>
            </div>
            <div className="rounded-xl bg-black/[0.03] p-3">
              <dt className="text-[0.65rem] uppercase tracking-wide text-[#5c6670]">
                Plug
              </dt>
              <dd className="font-medium text-[#12151a]">{data.plugStatus}</dd>
            </div>
          </dl>

          <div className="flex items-center justify-between text-xs text-[#5c6670]">
            <span>
              Source:{" "}
              <span className="font-semibold text-[#12151a]">
                {data.source === "mock" ? "Mock sandbox" : "Live Volvo API"}
              </span>
            </span>
            <span className="font-mono">
              {new Date(data.timestamp).toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
