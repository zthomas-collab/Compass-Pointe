import type { Metadata } from "next";
import Link from "next/link";
import { EventStatusBadge } from "@/components/event-ui";
import { getDriver } from "@/server/db";
import { EVENT_CATEGORY_LABELS, listPublicEvents } from "@/server/modules/events";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function PublicEvents({ searchParams }: { searchParams: Promise<{ zip?: string }> }) {
  const { zip } = await searchParams;
  const events = await listPublicEvents(await getDriver(), { zip });
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Events</h1>
      <p className="mt-2 text-muted">Response events coordinators have chosen to share. Locations are shown by ZIP code only.</p>
      <form method="get" className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        <label className="field"><span>Search by ZIP code</span><input className="input" name="zip" defaultValue={zip ?? ""} inputMode="numeric" maxLength={5} pattern="[0-9]{5}" /></label>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <section className="mt-4 grid gap-4" aria-label="Events">
        {events.length === 0 ? <p className="text-sm text-muted">No public events match.</p> : events.map((e) => (
          <article key={e.id} className="card p-4">
            <h2 className="text-xl"><Link className="underline" href={`/events/${e.reference}`}>{e.name}</Link></h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm"><EventStatusBadge status={e.status} /><span>{EVENT_CATEGORY_LABELS[e.category]}</span>
              <span className="text-muted">{e.countyName} County · ZIP {e.zips.join(", ")} · {e.startDate}{e.endDate ? ` to ${e.endDate}` : ""}</span></div>
            <p className="mt-2 text-sm">{e.summary}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
