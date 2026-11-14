import Link from "next/link";
import { EVENT_STATUS_LABELS, TASK_STATUS_LABELS, type EventStatus, type EventSummary, type TaskPriority, type TaskStatus } from "@/server/modules/events";

const STATUS_TONE: Record<EventStatus, string> = { SCHEDULED: "tone-brand", ACTIVE: "tone-ok", COMPLETED: "tone-muted", CANCELED: "tone-bad" };
export const EventStatusBadge = ({ status }: { status: EventStatus }) => <span className={`badge ${STATUS_TONE[status]}`}>{EVENT_STATUS_LABELS[status]}</span>;

const PRI_TONE: Record<TaskPriority, string> = { LOW: "tone-muted", NORMAL: "tone-brand", HIGH: "tone-warn", CRITICAL: "tone-bad" };
export const TaskPriorityBadge = ({ priority }: { priority: TaskPriority }) => <span className={`badge ${PRI_TONE[priority]}`}>{priority.charAt(0) + priority.slice(1).toLowerCase()}</span>;
export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => (
  <span className={`badge ${status === "DONE" ? "tone-ok" : status === "BLOCKED" ? "tone-bad" : status === "IN_PROGRESS" ? "tone-brand" : "tone-muted"}`}>{TASK_STATUS_LABELS[status]}</span>
);

const pad = (n: number) => String(n).padStart(2, "0");
export function monthBounds(month: string | undefined): { year: number; month: number; from: string; to: string; prev: string; next: string; label: string } {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const year = Number(m.slice(0, 4));
  const mon = Number(m.slice(5, 7));
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const prev = mon === 1 ? `${year - 1}-12` : `${year}-${pad(mon - 1)}`;
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${pad(mon + 1)}`;
  return { year, month: mon, from: `${m}-01`, to: `${m}-${pad(last)}`, prev, next, label: new Date(Date.UTC(year, mon - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

/** Month grid; each event appears on every day it covers and links to its dashboard. */
export function EventCalendar({ events, month, basePath }: { events: EventSummary[]; month: ReturnType<typeof monthBounds>; basePath: string }) {
  const firstDow = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
  const days = Number(month.to.slice(8, 10));
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const key = (d: number) => `${month.from.slice(0, 7)}-${pad(d)}`;
  const on = (d: number) => events.filter((e) => e.startDate <= key(d) && key(d) <= (e.endDate ?? e.startDate));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Link className="btn btn-secondary" href={`${basePath}?view=calendar&month=${month.prev}`}>← Previous</Link>
        <h2 className="text-xl">{month.label}</h2>
        <Link className="btn btn-secondary" href={`${basePath}?view=calendar&month=${month.next}`}>Next →</Link>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[42rem] grid-cols-7 gap-px rounded-lg border border-line bg-line text-sm" role="grid" aria-label={`Events in ${month.label}`}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} role="columnheader" className="bg-neutral-bg px-2 py-1 text-xs font-semibold uppercase text-muted">{d}</div>)}
          {cells.map((d, i) => (
            <div key={i} role="gridcell" className="min-h-24 bg-surface p-1">
              {d && <>
                <div className="text-xs text-muted">{d}</div>
                <ul className="mt-1 grid gap-1">
                  {on(d).slice(0, 3).map((e) => (
                    <li key={e.id}><Link href={`/admin/events/${e.id}`} className="block truncate rounded bg-mint-soft px-1 py-0.5 text-xs font-semibold text-brand underline">{e.name}</Link></li>
                  ))}
                  {on(d).length > 3 && <li className="text-xs text-muted">+{on(d).length - 3} more</li>}
                </ul>
              </>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
