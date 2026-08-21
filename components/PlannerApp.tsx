"use client";

import { Map } from "@/components/Map";
import { TelemetryCard } from "@/components/TelemetryCard";
import {
  buildSimSegments,
  sampleSim,
  type SimSegment,
  type VehicleSimStatus,
} from "@/lib/driveSimulation";
import {
  estimateRangeKm,
  getVolvoModel,
  VOLVO_MODELS,
} from "@/lib/vehicles";
import type { EVRouteResult, GeoPoint, VolvoVehicleData } from "@/types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

interface PlaceOption {
  id: string;
  label: string;
  location: GeoPoint;
}

const PRESETS: PlaceOption[] = [
  {
    id: "got",
    label: "Göteborg Central",
    location: { lat: 57.7089, lng: 11.9735 },
  },
  {
    id: "sto",
    label: "Stockholm Central",
    location: { lat: 59.3293, lng: 18.0686 },
  },
  {
    id: "mal",
    label: "Malmö Central",
    location: { lat: 55.6092, lng: 13.0007 },
  },
  {
    id: "osl",
    label: "Oslo Sentral",
    location: { lat: 59.9111, lng: 10.7528 },
  },
];

export function PlannerApp() {
  const [modelId, setModelId] = useState("EX90");
  const [telemetry, setTelemetry] = useState<VolvoVehicleData | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);

  const [carOn, setCarOn] = useState(false);
  const [simStatus, setSimStatus] = useState<VehicleSimStatus>("off");
  const [animLocation, setAnimLocation] = useState<GeoPoint | null>(null);
  const [chargeUi, setChargeUi] = useState<{
    remaining: number;
    target: number;
    station?: string;
  } | null>(null);

  const [originId, setOriginId] = useState("vehicle");
  const [destId, setDestId] = useState("sto");
  const [minStops, setMinStops] = useState(0);
  const [maxStops, setMaxStops] = useState(3);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [route, setRoute] = useState<EVRouteResult | null>(null);

  const rafRef = useRef<number | null>(null);
  const segmentsRef = useRef<SimSegment[]>([]);
  const driveStartRef = useRef<number>(0);
  /** Always-current pin position (avoids stale React state when planning). */
  const vehiclePositionRef = useRef<GeoPoint | null>(null);

  const model = useMemo(() => getVolvoModel(modelId), [modelId]);

  const stopDriveLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const applyTelemetryPatch = useCallback(
    (patch: Partial<VolvoVehicleData>) => {
      setTelemetry((prev) => {
        if (!prev) return prev;
        const soc = patch.socPercent ?? prev.socPercent;
        const location = patch.location ?? prev.location;
        if (patch.location) {
          vehiclePositionRef.current = patch.location;
        }
        return {
          ...prev,
          ...patch,
          socPercent: soc,
          location,
          remainingRangeKm: estimateRangeKm(
            soc,
            prev.batteryCapacityKwh,
            model.averageWhPerKm,
          ),
          timestamp: new Date().toISOString(),
        };
      });
    },
    [model.averageWhPerKm],
  );

  const fetchTelemetry = useCallback(
    async (opts?: { resetLocation?: boolean }) => {
      setTelemetryLoading(true);
      setTelemetryError(null);
      try {
        const res = await fetch(
          `/api/telemetry?model=${encodeURIComponent(modelId)}&forceMock=1`,
        );
        const data = (await res.json()) as VolvoVehicleData;
        if (!res.ok) {
          throw new Error(
            (data as unknown as { error?: string }).error ||
              "Telemetry request failed",
          );
        }

        // Keep the car where it is after a drive — don't snap home on refresh.
        const preservedLocation = opts?.resetLocation
          ? undefined
          : (vehiclePositionRef.current ?? undefined);

        setTelemetry((prev) => {
          const nextSoc =
            opts?.resetLocation || !prev ? data.socPercent : prev.socPercent;
          const next = {
            ...data,
            location: preservedLocation ?? data.location,
            socPercent: nextSoc,
          };
          next.remainingRangeKm = estimateRangeKm(
            next.socPercent,
            next.batteryCapacityKwh,
            getVolvoModel(modelId).averageWhPerKm,
          );
          return next;
        });

        const loc = preservedLocation ?? data.location;
        vehiclePositionRef.current = loc;
        setAnimLocation(loc);
      } catch (err) {
        setTelemetryError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setTelemetryLoading(false);
      }
    },
    [modelId],
  );

  useEffect(() => {
    stopDriveLoop();
    setCarOn(false);
    setSimStatus("off");
    setRoute(null);
    setChargeUi(null);
    setAnimLocation(null);
    vehiclePositionRef.current = null;
    void fetchTelemetry({ resetLocation: true });
  }, [modelId, stopDriveLoop, fetchTelemetry]);

  useEffect(() => () => stopDriveLoop(), [stopDriveLoop]);

  useEffect(() => {
    if (animLocation) vehiclePositionRef.current = animLocation;
  }, [animLocation]);

  /** Live pin position for "Current vehicle location". */
  const currentVehicleLocation =
    animLocation ?? telemetry?.location ?? null;

  const origin = useMemo(() => {
    if (originId === "vehicle") return currentVehicleLocation;
    return PRESETS.find((p) => p.id === originId)?.location ?? null;
  }, [originId, currentVehicleLocation]);

  const originLabel = useMemo(() => {
    if (originId === "vehicle") {
      return telemetry ? `Vehicle (${telemetry.model})` : "Vehicle";
    }
    return PRESETS.find((p) => p.id === originId)?.label ?? "Origin";
  }, [originId, telemetry]);

  const destination = useMemo(
    () => PRESETS.find((p) => p.id === destId)?.location ?? null,
    [destId],
  );

  const destinationLabel =
    PRESETS.find((p) => p.id === destId)?.label ?? "Destination";

  const mapVehicleLocation = animLocation ?? telemetry?.location ?? null;
  const isDriving = simStatus === "driving" || simStatus === "charging";

  async function onPlan(e: FormEvent) {
    e.preventDefault();

    const resolvedOrigin =
      originId === "vehicle"
        ? (vehiclePositionRef.current ??
          animLocation ??
          telemetry?.location ??
          null)
        : (PRESETS.find((p) => p.id === originId)?.location ?? null);

    if (!resolvedOrigin || !destination || !telemetry) {
      setPlanError("Need vehicle telemetry and a destination.");
      return;
    }

    stopDriveLoop();
    setSimStatus(carOn ? "idle" : "off");
    setChargeUi(null);
    setPlanning(true);
    setPlanError(null);

    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: resolvedOrigin,
          destination,
          originLabel,
          destinationLabel,
          socPercent: telemetry.socPercent,
          batteryCapacityKwh: telemetry.batteryCapacityKwh,
          averageWhPerKm: model.averageWhPerKm,
          minChargingStops: minStops,
          maxChargingStops: Math.max(minStops, maxStops),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Route planning failed");
      setRoute(data as EVRouteResult);
      vehiclePositionRef.current = resolvedOrigin;
      setAnimLocation(resolvedOrigin);
      applyTelemetryPatch({ location: resolvedOrigin });
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPlanning(false);
    }
  }

  function toggleCar() {
    if (isDriving) return;

    if (carOn) {
      setCarOn(false);
      setSimStatus("off");
      applyTelemetryPatch({ lockStatus: "LOCKED", plugStatus: "DISCONNECTED" });
      return;
    }

    setCarOn(true);
    setSimStatus("idle");
    applyTelemetryPatch({ lockStatus: "UNLOCKED" });
  }

  function startDrive() {
    if (!carOn || !route || isDriving) return;

    const segments = buildSimSegments(route);
    if (segments.length === 0) return;

    segmentsRef.current = segments;
    driveStartRef.current = performance.now();
    stopDriveLoop();

    const tick = (now: number) => {
      const elapsed = now - driveStartRef.current;
      const frame = sampleSim(segmentsRef.current, elapsed);

      vehiclePositionRef.current = frame.location;
      setAnimLocation(frame.location);
      setSimStatus(frame.status);
      applyTelemetryPatch({
        location: frame.location,
        socPercent: frame.socPercent,
        plugStatus: frame.status === "charging" ? "CONNECTED" : "DISCONNECTED",
      });

      if (frame.status === "charging") {
        setChargeUi({
          remaining: frame.chargeRemainingPercent ?? 0,
          target: frame.chargeTargetPercent ?? 80,
          station: frame.chargeStationName,
        });
      } else {
        setChargeUi(null);
      }

      if (frame.status === "arrived" || frame.progress >= 1) {
        vehiclePositionRef.current = frame.location;
        setSimStatus("arrived");
        setChargeUi(null);
        setCarOn(true);
        applyTelemetryPatch({
          location: frame.location,
          socPercent: frame.socPercent,
          plugStatus: "DISCONNECTED",
          lockStatus: "UNLOCKED",
        });
        rafRef.current = null;
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside className="z-10 flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-b border-black/10 bg-[#f3f6f8]/95 p-4 backdrop-blur md:h-full md:w-[400px] md:border-b-0 md:border-r">
        <header>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[#0b6e6a]">
            Smart EV Route Planner
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-[#12151a]">
            Volvo Connected Range
          </h1>
          <p className="mt-1 text-sm text-[#5c6670]">
            Pick a model, plan with live range, then drive the route.
          </p>
        </header>

        <label className="block rounded-2xl border border-black/10 bg-white/75 p-4 text-sm shadow-sm backdrop-blur">
          <span className="mb-1 block text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[#5c6670]">
            Volvo model
          </span>
          <select
            value={modelId}
            disabled={isDriving}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[#12151a] outline-none focus:border-[#0b6e6a] disabled:opacity-50"
          >
            {VOLVO_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.batteryCapacityKwh} kWh · ~{m.averageWhPerKm}{" "}
                Wh/km
              </option>
            ))}
          </select>
        </label>

        <TelemetryCard
          data={telemetry}
          loading={telemetryLoading}
          error={telemetryError}
          carOn={carOn}
          simStatus={simStatus}
          onRefresh={() => void fetchTelemetry()}
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={toggleCar}
            disabled={!telemetry || isDriving}
            className={`rounded-xl px-3 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
              carOn
                ? "bg-[#dc3d3d] shadow-[0_10px_24px_rgba(220,61,61,0.28)] hover:bg-[#b83232]"
                : "bg-[#0b6e6a] shadow-[0_10px_24px_rgba(11,110,106,0.28)] hover:bg-[#084e4b]"
            }`}
          >
            {carOn ? "Stop car" : "Start car"}
          </button>
          <button
            type="button"
            onClick={startDrive}
            disabled={!carOn || !route || isDriving}
            className="rounded-xl bg-[#12151a] px-3 py-3 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDriving ? "Driving…" : "Drive"}
          </button>
        </div>

        {chargeUi && (
          <p className="rounded-xl border border-[#d97706]/35 bg-[#d97706]/10 px-3 py-2 text-sm text-[#92400e]">
            Charging at {chargeUi.station ?? "station"} —{" "}
            <strong>{chargeUi.remaining.toFixed(1)}%</strong> remaining to{" "}
            {Math.round(chargeUi.target)}%
          </p>
        )}

        <form
          onSubmit={onPlan}
          className="space-y-3 rounded-2xl border border-black/10 bg-white/75 p-4 shadow-sm backdrop-blur"
        >
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[#5c6670]">
            Trip
          </p>

          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[#5c6670]">
              Origin
            </span>
            <select
              value={originId}
              disabled={isDriving}
              onChange={(e) => setOriginId(e.target.value)}
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[#12151a] outline-none focus:border-[#0b6e6a] disabled:opacity-50"
            >
              <option value="vehicle">Current vehicle location</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[#5c6670]">
              Destination
            </span>
            <select
              value={destId}
              disabled={isDriving}
              onChange={(e) => setDestId(e.target.value)}
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[#12151a] outline-none focus:border-[#0b6e6a] disabled:opacity-50"
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[#5c6670]">
              Min charging stops
            </span>
            <select
              value={minStops}
              disabled={isDriving}
              onChange={(e) => {
                const next = Number(e.target.value);
                setMinStops(next);
                if (next > maxStops) setMaxStops(next);
              }}
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[#12151a] outline-none focus:border-[#0b6e6a] disabled:opacity-50"
            >
              <option value={0}>0 — only when range requires it</option>
              <option value={1}>1 break (shorter legs)</option>
              <option value={2}>2 breaks (kids / pets friendly)</option>
              <option value={3}>3 breaks</option>
              <option value={4}>4 breaks (frequent stops)</option>
              <option value={5}>5 breaks</option>
            </select>
            <span className="mt-1 block text-[0.7rem] text-[#5c6670]">
              Prefer more breaks even when the battery could go further.
            </span>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[#5c6670]">
              Max charging stops
            </span>
            <select
              value={maxStops}
              disabled={isDriving}
              onChange={(e) => {
                const next = Number(e.target.value);
                setMaxStops(next);
                if (next < minStops) setMinStops(next);
              }}
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[#12151a] outline-none focus:border-[#0b6e6a] disabled:opacity-50"
            >
              <option value={0}>0 — no charging stops</option>
              <option value={1}>1 stop (charge higher ~95%)</option>
              <option value={2}>2 stops (charge ~90%)</option>
              <option value={3}>3 stops (recommended)</option>
              <option value={4}>4 stops</option>
              <option value={5}>5 stops</option>
            </select>
            <span className="mt-1 block text-[0.7rem] text-[#5c6670]">
              Cap on stops; fewer max stops → charge more at each one.
            </span>
          </label>

          <button
            type="submit"
            disabled={planning || !telemetry || isDriving}
            className="w-full rounded-xl bg-[#0b6e6a] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(11,110,106,0.28)] transition hover:bg-[#084e4b] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {planning ? "Planning…" : "Plan Route with Volvo Range"}
          </button>

          {planError && (
            <p className="rounded-lg bg-[#dc3d3d]/10 px-3 py-2 text-sm text-[#dc3d3d]">
              {planError}
            </p>
          )}
        </form>

        {route && (
          <section className="rounded-2xl border border-black/10 bg-white/75 p-4 shadow-sm backdrop-blur">
            <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-[#5c6670]">
              Trip summary
            </p>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <SummaryStat
                label="Distance"
                value={`${route.totalDistanceKm.toFixed(0)} km`}
              />
              <SummaryStat
                label="Driving"
                value={`${Math.round(route.totalDrivingMinutes)} min`}
              />
              <SummaryStat
                label="Charging"
                value={`${route.totalChargingMinutes} min`}
              />
              <SummaryStat
                label="Arrival SoC"
                value={`${Math.round(route.arrivalSocPercent)}%`}
              />
              <SummaryStat
                label="Stops used"
                value={`${route.chargingStops.length} (${route.minChargingStops}–${route.maxChargingStops})`}
              />
              <SummaryStat
                label="Stop budget"
                value={route.withinMaxStops ? "OK" : "Tight"}
              />
            </dl>
            <p className="mt-2 text-[0.7rem] text-[#5c6670]">
              Sim timing: 1s / 10 km · 1s / 10% charge
            </p>

            {route.warnings?.length > 0 && (
              <ul className="mt-3 space-y-1.5 rounded-xl border border-[#d97706]/30 bg-[#d97706]/10 p-3">
                {route.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-[#92400e]">
                    {w}
                  </li>
                ))}
              </ul>
            )}

            {route.chargingStops.length > 0 ? (
              <ul className="mt-3 space-y-2 border-t border-black/5 pt-3">
                {route.chargingStops.map((stop, index) => (
                  <li key={`${stop.id}-${index}`} className="text-sm">
                    <p className="font-semibold text-[#12151a]">{stop.name}</p>
                    <p className="text-xs text-[#5c6670]">
                      {stop.town ? `${stop.town} · ` : ""}
                      {stop.powerKw} kW · ~{stop.estimatedChargeMinutes ?? "?"}{" "}
                      min charge
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-[#5c6670]">
                No charging stop required for this trip.
              </p>
            )}
          </section>
        )}
      </aside>

      <main className="relative min-h-[45vh] flex-1 md:min-h-0">
        <Map
          vehicleLocation={mapVehicleLocation}
          vehicleState={{
            status: simStatus,
            chargeRemainingPercent: chargeUi?.remaining,
            chargeTargetPercent: chargeUi?.target,
            chargeStationName: chargeUi?.station,
          }}
          destination={destination}
          route={route}
          followVehicle={isDriving}
          className="absolute inset-0 h-full w-full"
        />
      </main>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/[0.03] p-3">
      <dt className="text-[0.65rem] uppercase tracking-wide text-[#5c6670]">
        {label}
      </dt>
      <dd className="font-mono text-base font-medium text-[#12151a]">{value}</dd>
    </div>
  );
}
