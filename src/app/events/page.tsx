import type { Metadata } from "next";
import Link from "next/link";
import { EventStatusBadge, HAZARD_LABELS } from "@/components/event-status";
import { getDriver } from "@/server/db";
import { listPublicEvents, type EventRow } from "@/server/modules/events";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

function EventList({ events }: { events: EventRow[] }) {
  return (
    <ul className="mt-2 grid gap-3 sm:grid-cols-2">
      {events.map((e) => (
        <li key={e.id} className="card p-4">
          <Link className="text-lg font-semibold text-brand underline" href={`/events/${e.slug}`}>{e.name}</Link>
          <p className="mt-1"><EventStatusBadge status={e.status} /></p>
          <p className="mt-1 text-sm text-muted">
            {HAZARD_LABELS[e.hazardType] ?? e.hazardType} · {e.counties.map((c) => `${c.name}, ${c.state}`).join("; ")}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Public list of disaster events: open ones first, closed ones in an archive. */
export default async function EventsPage() {
  const events = await listPublicEvents(await getDriver());
  const open = events.filter((e) => e.status !== "CLOSED");
  const archive = events.filter((e) => e.status === "CLOSED");
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Events</h1>
      <p className="mt-1 text-sm text-muted">Each event is a named disaster area. Open one to see the help available there.</p>

      <section className="mt-6" aria-labelledby="open-h">
        <h2 id="open-h" className="text-xl">Open events</h2>
        {open.length ? <EventList events={open} /> : <p className="mt-2 text-sm text-muted">No events are currently open.</p>}
      </section>

      {archive.length > 0 && (
        <section className="mt-8" aria-labelledby="archive-h">
          <h2 id="archive-h" className="text-xl">Archive</h2>
          <EventList events={archive} />
        </section>
      )}
    </div>
  );
}
