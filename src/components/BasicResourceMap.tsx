"use client";

import { useEffect, useRef, useState } from "react";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { MapResult } from "@/server/modules/map";

export type MapBounds = { w: number; s: number; e: number; n: number };
export const STATE_BOUNDARIES_URL = "/maps/us-states.geojson";
type Boundaries = FeatureCollection<Polygon | MultiPolygon>;

export function BasicResourceMap({ bounds, sites, selectedId }: {
  bounds: MapBounds;
  sites: MapResult["sites"];
  selectedId: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [boundaries, setBoundaries] = useState<Boundaries | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(STATE_BOUNDARIES_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load state boundaries.");
        return response.json() as Promise<Boundaries>;
      })
      .then(setBoundaries)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const surface = canvas.current;
    const ctx = surface?.getContext("2d");
    if (!surface || !ctx || !boundaries) return;

    const { width, height } = surface;
    const { w, s, e, n } = bounds;
    const longitudeScale = Math.cos(((s + n) / 2) * Math.PI / 180);
    const scale = Math.min((width - 32) / ((e - w) * longitudeScale), (height - 32) / (n - s));
    const project = (lng: number, lat: number): [number, number] => [
      width / 2 + (lng - (w + e) / 2) * scale * longitudeScale,
      height / 2 - (lat - (s + n) / 2) * scale,
    ];

    ctx.fillStyle = "#dceaf2";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#edf2e6";
    ctx.strokeStyle = "#71867d";
    ctx.lineWidth = 1;
    for (const { geometry } of boundaries.features) {
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      for (const polygon of polygons) {
        ctx.beginPath();
        for (const ring of polygon) {
          const [[lng, lat], ...rest] = ring;
          ctx.moveTo(...project(lng, lat));
          for (const [x, y] of rest) ctx.lineTo(...project(x, y));
          ctx.closePath();
        }
        ctx.fill("evenodd");
        ctx.stroke();
      }
    }

    for (const site of sites) {
      ctx.beginPath();
      ctx.arc(...project(site.lng, site.lat), site.id === selectedId ? 12 : 8, 0, Math.PI * 2);
      ctx.fillStyle = site.serviceColor ?? "#263238";
      ctx.strokeStyle = site.id === selectedId ? "#263238" : "#fff";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }
  }, [boundaries, bounds, selectedId, sites]);

  return (
    <figure className="absolute inset-0 flex flex-col bg-surface">
      <canvas ref={canvas} width={900} height={540} role="img" aria-label="U.S. state boundaries and nearby resource locations" className="min-h-0 w-full flex-1 bg-[#dceaf2] object-contain" />
      <figcaption className="p-2 text-xs text-muted">
        {failed ? "State boundaries could not load. Use search and the resource list."
          : boundaries ? "Basic map · U.S. Census Bureau / us-atlas. Search by ZIP or use the resource list for details."
          : "Loading U.S. state boundaries…"}
      </figcaption>
    </figure>
  );
}
