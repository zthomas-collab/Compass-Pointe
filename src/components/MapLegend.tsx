"use client";

import { useState } from "react";
import { STATUS_KEY } from "@/lib/domain";
import type { ServiceType } from "@/server/modules/directory";
import { BRAND_FOREST, CHARCOAL, STATUS_FILL } from "./map-shared";
import { StatusIcon } from "./status-icons";

/**
 * Map key: explains every color and mark used on the map. On larger screens it is a fixed
 * column on the left running the full height of the map. On phones it is a button that opens
 * the same full-height panel over the left side of the map.
 */
export function MapLegend({ serviceTypes, selected, onToggle, onReset }: { serviceTypes: ServiceType[]; selected: string[]; onToggle: (code: string) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`z-10 flex flex-col bg-surface text-xs md:static md:w-56 md:flex-none xl:w-64 md:rounded-none md:border-0 md:border-r md:border-line md:shadow-none ${
        open ? "absolute inset-y-0 left-0 w-[17rem] max-w-[85%] border-r border-line shadow-lg" : "absolute left-2 top-2 rounded-lg border border-line shadow"
      }`}
    >
      <h2 className="m-0 border-line px-2 py-2 md:border-b">
      <button type="button" className="flex w-full items-center justify-between gap-2 text-sm font-bold md:cursor-default" aria-expanded={open} aria-controls="map-key" onClick={() => setOpen((v) => !v)}>
        Map key{selected.length ? ` · ${selected.length} type${selected.length === 1 ? "" : "s"} shown` : ""}
        <span aria-hidden className="md:hidden">{open ? "▾" : "▸"}</span>
      </button>
      </h2>
      <div id="map-key" className={`${open ? "block" : "hidden"} min-h-0 flex-1 overflow-y-auto px-2 pb-3 md:block`}>
        <h3 className="mt-2 font-bold text-ink">Availability (badge on each pin)</h3>
        <ul className="mt-1 grid gap-1">
          {STATUS_KEY.filter((k) => k.kind !== "unknown").map((k) => (
            <li key={k.kind} className="flex items-center gap-2">
              <span aria-hidden className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[10px] font-bold"
                style={{ background: STATUS_FILL[k.kind].fill, color: STATUS_FILL[k.kind].text, borderColor: CHARCOAL }}>{k.letter}</span>
              <span className={`status status-${k.kind}`}><StatusIcon kind={k.kind} size={12} />{k.label}</span>
              <span className="sr-only">: {k.meaning}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-muted">“?” also means the organization reported Unknown.</p>

        <h3 className="mt-3 font-bold text-ink">Organization type (pin color + code)</h3>
        <p className="text-muted">Tap a type to show only those.</p>
        <ul className="mt-1 grid gap-0.5" aria-label="Filter by organization type">
          {serviceTypes.map((t) => {
            const on = selected.includes(t.code);
            return (
              <li key={t.code}>
                <button type="button" aria-pressed={on} onClick={() => onToggle(t.code)}
                  className={`flex min-h-8 w-full items-center gap-2 rounded px-1 text-left ${on ? "bg-mint-soft font-semibold ring-1 ring-brand" : "hover:bg-mint-soft"}`}>
                  <span aria-hidden className="inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white" style={{ background: t.color }}>{t.shortLabel}</span>
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
        {selected.length > 0 && <button type="button" className="mt-1 text-brand underline" onClick={onReset}>Show all types</button>}

        <h3 className="mt-3 font-bold text-ink">Other marks</h3>
        <ul className="mt-1 grid gap-1 text-ink">
          <li className="flex items-center gap-2">
            <span aria-hidden className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white ring-2 ring-white" style={{ background: BRAND_FOREST }}>5</span>
            Group of 5 locations — tap or zoom in
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-6 w-6 flex-none rounded-full" style={{ background: "#263238", boxShadow: `0 0 0 4px ${CHARCOAL}`, outline: "2px solid #fff" }} />
            Thick dark outline: restricted location (signed-in, authorized users only)
          </li>
        </ul>
      </div>
    </div>
  );
}
