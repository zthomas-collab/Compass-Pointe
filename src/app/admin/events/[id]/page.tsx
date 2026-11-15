import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventForm, StatusButton } from "@/components/event-forms";
import { EventStatusBadge } from "@/components/event-status";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { ALLOWED_TRANSITIONS, getEventAdmin, type EventRow } from "@/server/modules/events";
import { requireUser } from "@/server/session";
import { setEventStatusAction, updateEventAction } from "../actions";
import { gateAdminError } from "../gate";

export const metadata: Metadata = { title: "Edit event", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { created } = await searchParams;
  const db = await getDriver();
  let event: EventRow | null;
  try {
    event = await getEventAdmin(db, user.id, id);
  } catch (err) {
    return gateAdminError(err);
  }
  if (!event) notFound();
  const counties = await listCounties(db);
  const next = ALLOWED_TRANSITIONS[event.status].filter((s) => s !== "DRAFT");
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/admin/events" className="text-sm text-brand underline">← All events</Link>
      <h1 className="mt-2 text-2xl font-bold">{event.name}</h1>
      <p className="mt-1">
        <EventStatusBadge status={event.status} />
        {event.status !== "DRAFT" && <Link className="ml-2 text-sm underline" href={`/events/${event.slug}`}>View public page</Link>}
      </p>
      {created && (
        <p role="status" className="mt-3 rounded-md bg-ok-bg p-3 text-sm text-ok">
          Draft created. It is private until you make it active.
        </p>
      )}

      <section className="card mt-5 p-4" aria-labelledby="status-h">
        <h2 id="status-h" className="text-lg font-semibold">Status</h2>
        {next.length === 0 ? (
          <p className="mt-1 text-sm text-muted">This event is closed. It stays public as an archive and cannot be reopened.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-3">
            {next.map((to) => (
              <StatusButton key={to} to={to} action={setEventStatusAction.bind(null, event.id, to)} />
            ))}
          </div>
        )}
      </section>

      <section className="card mt-5 p-4" aria-labelledby="edit-h">
        <h2 id="edit-h" className="mb-2 text-lg font-semibold">Details</h2>
        {event.status === "CLOSED" ? (
          <dl className="grid gap-1 text-sm">
            <div><dt className="inline font-medium">Started:</dt> <dd className="inline">{event.startsOn}</dd></div>
            <div><dt className="inline font-medium">Closed:</dt> <dd className="inline">{event.closedOn}</dd></div>
            <div><dt className="inline font-medium">Counties:</dt> <dd className="inline">{event.counties.map((c) => `${c.name}, ${c.state}`).join("; ")}</dd></div>
            {event.zips.length > 0 && <div><dt className="inline font-medium">ZIP codes:</dt> <dd className="inline">{event.zips.join(", ")}</dd></div>}
            {event.summary && <div className="mt-2 whitespace-pre-line">{event.summary}</div>}
            <p className="mt-2 text-muted">A closed event is an archive and cannot be edited.</p>
          </dl>
        ) : (
          <EventForm action={updateEventAction.bind(null, event.id)} counties={counties} event={event} />
        )}
      </section>
    </div>
  );
}
