import type { Metadata } from "next";
import Link from "next/link";
import { EventForm } from "@/components/event-forms";
import { EventStatusBadge, HAZARD_LABELS } from "@/components/event-status";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { listEventsAdmin, type EventRow } from "@/server/modules/events";
import { requireUser } from "@/server/session";
import { createEventAction } from "./actions";
import { gateAdminError } from "./gate";

export const metadata: Metadata = { title: "Events", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminEventsPage() {
  const user = await requireUser();
  const db = await getDriver();
  let events: EventRow[];
  try {
    events = await listEventsAdmin(db, user.id);
  } catch (err) {
    return gateAdminError(err);
  }
  const counties = await listCounties(db);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/admin" className="text-sm text-brand underline">← Administration</Link>
      <h1 className="mt-2 text-2xl font-bold">Events</h1>
      <p className="text-sm text-muted">
        An event is a named disaster area. Drafts are private; an event becomes public when you make it active.
      </p>

      <section className="mt-6" aria-labelledby="events-h">
        <h2 id="events-h" className="text-lg font-semibold">All events</h2>
        <ul className="mt-2 divide-y divide-line">
          {events.map((e) => (
            <li key={e.id} className="py-3">
              <Link className="font-medium text-brand underline" href={`/admin/events/${e.id}`}>{e.name}</Link>{" "}
              <EventStatusBadge status={e.status} />
              <p className="text-xs text-muted">
                {HAZARD_LABELS[e.hazardType] ?? e.hazardType} · started {e.startsOn} · {e.counties.map((c) => `${c.name}, ${c.state}`).join("; ")}
              </p>
            </li>
          ))}
          {events.length === 0 && <li className="py-3 text-sm text-muted">No events yet.</li>}
        </ul>
      </section>

      <section className="card mt-6 p-4" aria-labelledby="new-h">
        <h2 id="new-h" className="mb-2 text-lg font-semibold">New event</h2>
        <EventForm action={createEventAction} counties={counties} />
      </section>
    </div>
  );
}
