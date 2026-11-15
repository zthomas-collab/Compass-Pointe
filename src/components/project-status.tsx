import type { ProjectStatus } from "@/lib/projects";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, { label: string; tone: string; icon: string }> = {
  DRAFT: { label: "Draft (not public)", tone: "tone-muted", icon: "✎" },
  PENDING_REVIEW: { label: "Waiting for review", tone: "tone-warn", icon: "⏳" },
  OPEN: { label: "Open to volunteers", tone: "tone-ok", icon: "●" },
  PAUSED: { label: "Paused (not public)", tone: "tone-warn", icon: "‖" },
  COMPLETED: { label: "Completed", tone: "tone-brand", icon: "✓" },
  CANCELLED: { label: "Cancelled", tone: "tone-bad", icon: "✕" },
};

/** Project status: icon + text + color, never color alone. */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const l = PROJECT_STATUS_LABELS[status];
  return (
    <span className={`badge ${l.tone}`}>
      <span aria-hidden="true">{l.icon}</span> {l.label}
    </span>
  );
}
