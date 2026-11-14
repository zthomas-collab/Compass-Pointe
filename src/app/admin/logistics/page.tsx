import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskMoveForm } from "@/components/event-forms";
import { TaskPriorityBadge, TaskStatusBadge } from "@/components/event-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { LOGISTICS_SORTS, TASK_STATUSES, TASK_STATUS_LABELS, listLogistics, type LogisticsSort } from "@/server/modules/events";
import { requireUser } from "@/server/session";
import { taskStatusAction } from "../../events/actions";

export const metadata: Metadata = { title: "Logistics", robots: { index: false } };
export const dynamic = "force-dynamic";
type Search = { sort?: string; dir?: string; status?: string; eventId?: string };
const COLUMNS: [LogisticsSort, string][] = [["event", "Event"], ["priority", "Priority"], ["status", "Status"], ["due", "Due"], ["assignee", "Assigned to"]];

/** One sortable table of logistics tasks across the events the signed-in person can see. */
export default async function Logistics({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  let tasks;
  try {
    tasks = await listLogistics(await getDriver(), user.id, sp);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filters and try again.</p>;
    throw err;
  }
  const sort = (LOGISTICS_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as LogisticsSort) : "due";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  const link = (col: string) => {
    const next = sort === col && dir === "asc" ? "desc" : "asc";
    return `?${new URLSearchParams({ ...(sp.status ? { status: sp.status } : {}), ...(sp.eventId ? { eventId: sp.eventId } : {}), sort: col, dir: next }).toString()}`;
  };
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/events">← Events</Link></p>
      <h1 className="mt-2 text-3xl">Logistics</h1>
      <form method="get" className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        <input type="hidden" name="sort" value={sort} /><input type="hidden" name="dir" value={dir} />
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}</select></label>
        <button className="btn btn-primary" type="submit">Filter</button>
      </form>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="w-full min-w-[44rem] text-sm">
          <caption className="sr-only">Logistics tasks, sortable by column</caption>
          <thead><tr className="border-b border-line text-left">
            <th scope="col" className="p-2 text-xs uppercase text-muted">Task</th>
            {COLUMNS.map(([col, label]) => (
              <th key={col} scope="col" className="p-2 text-xs uppercase" aria-sort={sort === col ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                <Link className="underline" href={link(col)}>{label}{sort === col ? (dir === "asc" ? " ▲" : " ▼") : ""}</Link>
              </th>
            ))}
            <th scope="col" className="p-2 text-xs uppercase text-muted">Move</th></tr></thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan={7} className="p-4 text-muted">No tasks.</td></tr>}
            {tasks.map((t) => (
              <tr key={t.id} className="border-b border-line align-top">
                <th scope="row" className="p-2 text-left font-semibold">{t.title}{t.overdue && <span className="badge tone-bad ml-2">Overdue</span>}</th>
                <td className="p-2"><Link className="underline" href={`/admin/events/${t.eventId}`}>{t.eventName}</Link></td>
                <td className="p-2"><TaskPriorityBadge priority={t.priority} /></td>
                <td className="p-2"><TaskStatusBadge status={t.status} /></td>
                <td className="p-2">{t.dueDate ?? "—"}</td>
                <td className="p-2">{[t.assigneeOrg, t.assigneeUser].filter(Boolean).join(" · ") || "—"}</td>
                <td className="p-2"><TaskMoveForm action={taskStatusAction} taskId={t.id} eventId={t.eventId} current={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
