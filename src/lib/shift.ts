/** Shift times are shown in Eastern Time: the platform serves North and South Carolina. */
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

/**
 * A shift as one readable line, or null when it has no time at all. A shift with only a start or only an end says so
 * ("Starts ..." / "Ends ...") instead of leaving a dangling "to".
 */
export function formatShift(startsAt: string | null, endsAt: string | null): string | null {
  if (startsAt && endsAt) return `${fmt(startsAt)} to ${fmt(endsAt)} (Eastern Time)`;
  if (startsAt) return `Starts ${fmt(startsAt)} (Eastern Time)`;
  if (endsAt) return `Ends ${fmt(endsAt)} (Eastern Time)`;
  return null;
}
