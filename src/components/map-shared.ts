import { STATUS_KEY, type StatusKind } from "@/lib/domain";

/*
 * Pieces shared by the map (ResourceMap), its site panel (SiteDetail) and its key (MapLegend). Client-safe: no server
 * imports.
 */

/** Map-marker status badge colors (semantic, reserved for resource status). Text color keeps >= 4.5:1. */
export const STATUS_FILL: Record<StatusKind, { fill: string; text: string }> = {
  available: { fill: "#2E7D32", text: "#FFFFFF" },
  limited: { fill: "#F0B84B", text: "#24343A" },
  depleted: { fill: "#C62828", text: "#FFFFFF" },
  closed: { fill: "#B0BEC5", text: "#24343A" },
  unknown: { fill: "#ECEFF1", text: "#24343A" },
  unconfirmed: { fill: "#ECEFF1", text: "#24343A" },
};
export const BRAND_FOREST = "#205C4B";
export const CHARCOAL = "#24343A";
export const statusMatch = (key: "fill" | "text") =>
  ["match", ["get", "status"], ...STATUS_KEY.flatMap((k) => [k.kind, STATUS_FILL[k.kind][key]]), STATUS_FILL.unconfirmed[key]] as unknown as string;

export function fmtTime(iso: string | null) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
