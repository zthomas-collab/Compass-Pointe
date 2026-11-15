import type { EventStatus } from "@/server/modules/events";

const LOOK: Record<EventStatus, { label: string; tone: string; icon: string }> = {
  DRAFT: { label: "Draft (not public)", tone: "tone-muted", icon: "✎" },
  ACTIVE: { label: "Active", tone: "tone-ok", icon: "●" },
  RECOVERY: { label: "Recovery", tone: "tone-warn", icon: "◐" },
  CLOSED: { label: "Closed", tone: "tone-brand", icon: "✓" },
};

export const HAZARD_LABELS: Record<string, string> = {
  HURRICANE: "Hurricane",
  FLOOD: "Flood",
  WILDFIRE: "Wildfire",
  TORNADO: "Tornado",
  WINTER_STORM: "Winter storm",
  EARTHQUAKE: "Earthquake",
  OTHER: "Other",
};

/** Event lifecycle status: icon + text + color, never color alone. */
export function EventStatusBadge({ status }: { status: EventStatus }) {
  const l = LOOK[status];
  return (
    <span className={`badge ${l.tone}`}>
      <span aria-hidden="true">{l.icon}</span> {l.label}
    </span>
  );
}
