/** Client-safe project constants (no server imports): shared by the service and the forms. */
export const PROJECT_AUDIENCES = ["COMMUNITY", "ORG_FACILITY", "HOUSEHOLD_GENERALIZED"] as const;
export const PROJECT_STATUSES = ["DRAFT", "PENDING_REVIEW", "OPEN", "PAUSED", "COMPLETED", "CANCELLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_AUDIENCE_LABELS: Record<(typeof PROJECT_AUDIENCES)[number], string> = {
  COMMUNITY: "Community or neighborhood",
  ORG_FACILITY: "The organization's own site",
  HOUSEHOLD_GENERALIZED: "Households (no names or addresses in public text)",
};

/** Shift times are typed and shown in Eastern Time: the platform serves North and South Carolina. */
export const eastern = "America/New_York";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: eastern, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** Wall-clock parts of an instant in Eastern Time, as a UTC-based millisecond count (so it can be compared to the typed value). */
function easternWallMs(instant: number): number {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}

/** "2026-12-06T08:00" typed in Eastern Time -> ISO UTC. Empty or unparseable input is returned unchanged for the schema to judge. */
export function easternLocalToIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return local;
  const asIfUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes settle the offset on both sides of a daylight-saving change.
  let instant = asIfUtc - (easternWallMs(asIfUtc) - asIfUtc);
  instant = asIfUtc - (easternWallMs(instant) - instant);
  return new Date(instant).toISOString();
}

/** ISO UTC -> "YYYY-MM-DDTHH:mm" in Eastern Time, for a datetime-local input. */
export function isoToEasternLocal(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(easternWallMs(t)).toISOString().slice(0, 16);
}
