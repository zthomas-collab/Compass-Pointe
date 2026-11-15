import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventStatusBadge, HAZARD_LABELS } from "@/components/event-status";
import { AvailabilityBadge } from "@/components/status";
import { getDriver } from "@/server/db";
import { formatShift } from "@/lib/shift";
import { listEventProjects } from "@/server/modules/eventlinks";
import { getEventHelp, getPublicEvent } from "@/server/modules/events";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const event = await getPublicEvent(await getDriver(), slug);
  return { title: event ? event.name : "Event not found" };
}

/** Public event page. Drafts and unknown slugs are a 404. */
export default async function EventPage({ params }: Params) {
  const { slug } = await params;
  const db = await getDriver();
  const event = await getPublicEvent(db, slug);
  if (!event) notFound();
  const [help, projects] = await Promise.all([getEventHelp(db, event.id), listEventProjects(db, event.id)]);
  const spotsLeft = projects.reduce((sum, p) => sum + p.spotsLeft, 0);
  const area = event.zips.length
    ? `ZIP codes ${event.zips.join(", ")}`
    : event.counties.map((c) => `${c.name}, ${c.state}`).join("; ");
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/events" className="text-sm text-brand underline">← All events</Link>
      <h1 className="mt-2 text-3xl">{event.name}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <EventStatusBadge status={event.status} />
        <span className="text-sm text-muted">
          {HAZARD_LABELS[event.hazardType] ?? event.hazardType} · started {event.startsOn}
          {event.closedOn && <> · closed {event.closedOn}</>}
        </span>
      </p>
      <p className="mt-1 text-sm text-muted">Area: {area}</p>
      {event.summary && <p className="mt-4 whitespace-pre-line">{event.summary}</p>}

      <section className="mt-8" aria-labelledby="help-h">
        <h2 id="help-h" className="text-xl">Help in this area</h2>
        {help.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No public help sites are listed for this area yet.</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {help.map((h) => (
              <li key={h.siteId} className="card p-4">
                <p className="font-semibold">{h.siteName}</p>
                <p className="text-sm text-muted">
                  {h.orgName}{h.city ? ` · ${h.city}` : ""}{h.postalCode ? ` ${h.postalCode}` : ""}{h.hoursText ? ` · ${h.hoursText}` : ""}
                </p>
                {h.resources.length > 0 && (
                  <ul className="mt-2 divide-y divide-line">
                    {h.resources.map((r) => (
                      <li key={`${h.siteId}-${r.name}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span>{r.name} <span className="text-sm text-muted">({r.categoryLabel})</span></span>
                        <AvailabilityBadge status={r.reportedStatus} freshness={r.freshness} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm"><Link className="underline" href="/">See all sites on the map</Link></p>
      </section>

      <section className="mt-8" aria-labelledby="needs-h">
        <h2 id="needs-h" className="text-xl">Needs</h2>
        {event.status === "CLOSED" ? (
          <p className="mt-2 text-sm text-muted">This event is closed. Its volunteer projects are no longer listed.</p>
        ) : projects.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No volunteer projects are linked to this event yet.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              {projects.length} volunteer project{projects.length === 1 ? "" : "s"} · {spotsLeft} spot{spotsLeft === 1 ? "" : "s"} left
            </p>
            <ul className="mt-3 grid gap-3">
              {projects.map((p) => (
                <li key={p.id} className="card p-4">
                  <Link className="text-lg font-semibold text-brand underline" href={`/projects/${p.id}`}>{p.title}</Link>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                    {p.hasUrgent && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent need</span>}
                    <span className={`badge ${p.spotsLeft > 0 ? "tone-brand" : "tone-muted"}`}>
                      {p.spotsLeft > 0 ? `${p.spotsLeft} of ${p.totalSlots} spots left` : `Full (${p.totalSlots} of ${p.totalSlots})`}
                    </span>
                    <span className="text-muted">{p.orgName} · {p.countyName}, {p.state} {p.zip}</span>
                  </p>
                  <ul className="mt-2 divide-y divide-line text-sm">
                    {p.needs.map((n) => (
                      <li key={n.id} className="py-1.5">
                        <span className="font-medium">{n.title}</span>
                        {n.urgency === "URGENT" && <span className="text-bad"> · urgent</span>}
                        <span className="text-muted">
                          {" · "}{n.ended ? "Shift ended" : n.spotsLeft > 0 ? `${n.spotsLeft} of ${n.slotsNeeded} spots left` : "Full"}
                          {formatShift(n.startsAt, n.endsAt) && <> · {formatShift(n.startsAt, n.endsAt)}</>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
