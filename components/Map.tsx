"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef } from "react";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { VehicleSimStatus } from "@/lib/driveSimulation";
import type { ChargingStation, EVRouteResult, GeoPoint } from "@/types";

export interface VehicleMarkerState {
  status: VehicleSimStatus;
  /** Remaining SoC % to charge when status is charging */
  chargeRemainingPercent?: number;
  chargeTargetPercent?: number;
  chargeStationName?: string;
}

export interface MapProps {
  vehicleLocation?: GeoPoint | null;
  vehicleState?: VehicleMarkerState | null;
  destination?: GeoPoint | null;
  route?: EVRouteResult | null;
  className?: string;
  /** When true, skip auto fitBounds (e.g. during drive animation). */
  followVehicle?: boolean;
}

const ROUTE_SOURCE = "ev-route";
const CHARGER_SOURCE = "ev-chargers";

function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function legsToFeatures(route: EVRouteResult): Feature[] {
  return route.legs.map((leg, index) => ({
    type: "Feature" as const,
    properties: {
      kind: leg.kind,
      index,
      label: `${leg.fromLabel} → ${leg.toLabel}`,
    },
    geometry: leg.geometry,
  }));
}

function chargersToFeatures(stops: ChargingStation[]): Feature[] {
  return stops.map((stop) => ({
    type: "Feature" as const,
    properties: {
      id: stop.id,
      name: stop.name,
      powerKw: stop.powerKw,
      minutes: stop.estimatedChargeMinutes ?? 0,
    },
    geometry: {
      type: "Point" as const,
      coordinates: [stop.location.lng, stop.location.lat],
    },
  }));
}

function ensureRouteLayers(map: mapboxgl.Map) {
  if (!map.getSource(ROUTE_SOURCE)) {
    map.addSource(ROUTE_SOURCE, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });

    map.addLayer({
      id: "ev-route-drive",
      type: "line",
      source: ROUTE_SOURCE,
      filter: ["==", ["get", "kind"], "drive"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#0b6e6a",
        "line-width": 5,
        "line-opacity": 0.9,
      },
    });

    map.addLayer({
      id: "ev-route-charger",
      type: "line",
      source: ROUTE_SOURCE,
      filter: ["==", ["get", "kind"], "to_charger"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#d97706",
        "line-width": 5,
        "line-opacity": 0.95,
      },
    });
  }

  if (!map.getSource(CHARGER_SOURCE)) {
    map.addSource(CHARGER_SOURCE, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });

    map.addLayer({
      id: "ev-charger-circles",
      type: "circle",
      source: CHARGER_SOURCE,
      paint: {
        "circle-radius": 10,
        "circle-color": "#d97706",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }
}

function renderVehicleMarkerHtml(state?: VehicleMarkerState | null): string {
  const status = state?.status ?? "off";
  if (status === "charging") {
    const remaining = state?.chargeRemainingPercent ?? 0;
    const target = state?.chargeTargetPercent ?? 80;
    return `
      <div class="volvo-marker volvo-marker--charging">
        <span class="volvo-marker-dot"></span>
        <div class="volvo-marker-badge">
          <strong>CHARGING</strong>
          <span>${remaining.toFixed(1)}% left → ${Math.round(target)}%</span>
        </div>
      </div>`;
  }

  const label =
    status === "driving"
      ? "DRIVING"
      : status === "idle"
        ? "ON"
        : status === "arrived"
          ? "ARRIVED"
          : "OFF";

  return `
    <div class="volvo-marker volvo-marker--${status}">
      <span class="volvo-marker-dot"></span>
      <div class="volvo-marker-badge volvo-marker-badge--compact">${label}</div>
    </div>`;
}

/**
 * Interactive Mapbox GL map: vehicle, destination, route polylines, charger pins.
 */
export function Map({
  vehicleLocation,
  vehicleState,
  destination,
  route,
  className,
  followVehicle = false,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const vehicleMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const destMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const lastStatusRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      return;
    }

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [11.9746, 57.7089],
      zoom: 10,
      attributionControl: true,
    });

    map.addControl(
      new mapboxgl.NavigationControl({ visualizePitch: false }),
      "top-right",
    );

    map.on("load", () => {
      ensureRouteLayers(map);
    });

    mapRef.current = map;

    return () => {
      vehicleMarkerRef.current?.remove();
      destMarkerRef.current?.remove();
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Vehicle marker position + status badge
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !vehicleLocation) return;

    const statusKey = `${vehicleState?.status ?? "off"}:${vehicleState?.chargeTargetPercent ?? ""}:${vehicleState?.chargeStationName ?? ""}`;

    const ensureMarker = () => {
      if (!vehicleMarkerRef.current) {
        const el = document.createElement("div");
        el.innerHTML = renderVehicleMarkerHtml(vehicleState);
        vehicleMarkerRef.current = new mapboxgl.Marker({
          element: el.firstElementChild as HTMLElement,
          anchor: "center",
        })
          .setLngLat([vehicleLocation.lng, vehicleLocation.lat])
          .addTo(map);
        lastStatusRef.current = statusKey;
        return;
      }

      vehicleMarkerRef.current.setLngLat([
        vehicleLocation.lng,
        vehicleLocation.lat,
      ]);

      if (statusKey !== lastStatusRef.current) {
        const wrap = document.createElement("div");
        wrap.innerHTML = renderVehicleMarkerHtml(vehicleState);
        const next = wrap.firstElementChild as HTMLElement;
        vehicleMarkerRef.current.remove();
        vehicleMarkerRef.current = new mapboxgl.Marker({
          element: next,
          anchor: "center",
        })
          .setLngLat([vehicleLocation.lng, vehicleLocation.lat])
          .addTo(map);
        lastStatusRef.current = statusKey;
      } else if (vehicleState?.status === "charging") {
        const badge = vehicleMarkerRef.current
          .getElement()
          .querySelector(".volvo-marker-badge span");
        if (badge) {
          const remaining = vehicleState.chargeRemainingPercent ?? 0;
          const target = vehicleState.chargeTargetPercent ?? 80;
          badge.textContent = `${remaining.toFixed(1)}% left → ${Math.round(target)}%`;
        }
      }
    };

    ensureMarker();

    if (followVehicle) {
      map.easeTo({
        center: [vehicleLocation.lng, vehicleLocation.lat],
        duration: 80,
        essential: true,
      });
    }
  }, [vehicleLocation, vehicleState, followVehicle]);

  // Destination marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!destination) {
      destMarkerRef.current?.remove();
      destMarkerRef.current = null;
      return;
    }

    if (!destMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "dest-marker";
      el.title = "Destination";
      destMarkerRef.current = new mapboxgl.Marker({
        element: el,
        anchor: "bottom",
      })
        .setLngLat([destination.lng, destination.lat])
        .addTo(map);
    } else {
      destMarkerRef.current.setLngLat([destination.lng, destination.lat]);
    }
  }, [destination]);

  // Route + charger layers + camera (only when route changes)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      ensureRouteLayers(map);
      const routeSource = map.getSource(ROUTE_SOURCE) as mapboxgl.GeoJSONSource;
      const chargerSource = map.getSource(
        CHARGER_SOURCE,
      ) as mapboxgl.GeoJSONSource;

      if (!route) {
        routeSource?.setData(emptyFeatureCollection());
        chargerSource?.setData(emptyFeatureCollection());
        return;
      }

      routeSource?.setData({
        type: "FeatureCollection",
        features: legsToFeatures(route),
      });
      chargerSource?.setData({
        type: "FeatureCollection",
        features: chargersToFeatures(route.chargingStops),
      });

      const bounds = new mapboxgl.LngLatBounds();
      for (const c of route.fullGeometry.coordinates) {
        bounds.extend(c as [number, number]);
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 72, maxZoom: 12, duration: 900 });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [route]);

  // Charger popups
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const feature = e.features?.[0] as Feature<Point> | undefined;
      if (!feature || feature.geometry.type !== "Point") return;
      const props = feature.properties ?? {};
      const coords = feature.geometry.coordinates as [number, number];

      popupRef.current?.remove();
      popupRef.current = new mapboxgl.Popup({ offset: 16, closeButton: true })
        .setLngLat(coords)
        .setHTML(
          `<div class="charger-popup">
            <strong>${props.name ?? "Charger"}</strong>
            <div>${props.powerKw ?? "?"} kW · ~${props.minutes ?? "?"} min</div>
          </div>`,
        )
        .addTo(map);
    };

    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    const bind = () => {
      if (!map.getLayer("ev-charger-circles")) return;
      map.on("click", "ev-charger-circles", onClick);
      map.on("mouseenter", "ev-charger-circles", onEnter);
      map.on("mouseleave", "ev-charger-circles", onLeave);
    };

    if (map.isStyleLoaded()) bind();
    else map.once("load", bind);

    return () => {
      if (map.getLayer("ev-charger-circles")) {
        map.off("click", "ev-charger-circles", onClick);
        map.off("mouseenter", "ev-charger-circles", onEnter);
        map.off("mouseleave", "ev-charger-circles", onLeave);
      }
    };
  }, [route]);

  const missingToken = !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  return (
    <div className={className ?? "relative h-full w-full"}>
      <div ref={containerRef} className="h-full w-full" />
      {missingToken && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#e8eef3]/95 p-8 text-center">
          <div className="max-w-md space-y-2">
            <p className="text-lg font-semibold text-[#12151a]">
              Mapbox token required
            </p>
            <p className="text-sm text-[#5c6670]">
              Set{" "}
              <code className="font-mono text-xs">
                NEXT_PUBLIC_MAPBOX_TOKEN
              </code>{" "}
              in <code className="font-mono text-xs">.env.local</code> to render
              the live map.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
