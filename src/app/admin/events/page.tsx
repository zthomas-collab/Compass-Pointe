import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventCalendar, EventStatusBadge, monthBounds } from "@/components/event-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listManageableCounties } from "@/server/modules/counties";
import { EVENT_CATEGORY_LABELS, EVENT_STATUSES, EVENT_STATUS_LABELS, listEvents } from "@/server/modules/events";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Events", robots: { index: false } };
export const dynamic = "force-dynamic";

type Search = { view?: string; month?: string; status?: string; countyId?: string };

export default async function EventsAdmin({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = await getDriver();
  const calendar = sp.view === "calendar";
  const month = monthBounds(sp.month);
  let events;
  try {
    events = await listEvents(db, user.id, calendar ? { ...sp, from: month.from, to: month.to, status: sp.status } : sp);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filters and try again.</p>;
    throw err;
  }
  const counties = await listManageableCounties(db, user.id).catch(() => []);
  const tab = (on: boolean) => `rounded-md border px-4 py-2 text-sm font-semibold ${on ? "border-brand bg-brand text-white" : "border-line bg-surface"}`;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl">Events</h1>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-secondary" href="/admin/logistics">Logistics table</Link>
          {counties.length > 0 && <Link className="btn btn-primary" href="/admin/events/new">New event</Link>}
        </div>
      </div>
      <nav className="mt-4 flex gap-2" aria-label="View">
        <Link className={tab(!calendar)} href="/admin/events" aria-current={!calendar ? "page" : undefined}>List</Link>
        <Link className={tab(calendar)} href="/admin/events?view=calendar" aria-current={calendar ? "page" : undefined}>Calendar</Link>
      </nav>
      <form method="get" className="card mt-4 grid gap-3 p-4 sm:grid-cols-4">
        {calendar && <><input type="hidden" name="view" value="calendar" /><input type="hidden" name="month" value={month.from.slice(0, 7)} /></>}
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>{EVENT_STATUSES.map((s) => <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>)}</select></label>
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={sp.countyId ?? ""}><option value="">Any</option>{counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}</select></label>
        <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Filter</button></div>
      </form>
      <section className="card mt-4 p-4" aria-label="Events">
        {calendar ? <EventCalendar events={events} month={month} basePath="/admin/events" /> : events.length === 0 ? <p className="text-sm text-muted">No events yet.</p> : (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="py-3">
                <Link className="font-semibold text-brand underline" href={`/admin/events/${e.id}`}>{e.name}</Link>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <EventStatusBadge status={e.status} /><span>{EVENT_CATEGORY_LABELS[e.category]}</span>
                  <span className="text-muted">{e.countyName} County · ZIP {e.zips.join(", ")} · {e.startDate}{e.endDate ? ` to ${e.endDate}` : ""}</span>
                  {e.visibility === "PUBLIC" && <span className="badge tone-ok">Public</span>}
                  <span className="text-xs text-muted">{e.taskDone} of {e.taskTotal} tasks done</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
