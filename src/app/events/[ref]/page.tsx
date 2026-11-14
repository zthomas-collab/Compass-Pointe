import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventStatusBadge } from "@/components/event-ui";
import { getDriver } from "@/server/db";
import { EVENT_CATEGORY_LABELS, getPublicEvent } from "@/server/modules/events";

export const metadata: Metadata = { title: "Event" };
export const dynamic = "force-dynamic";

export default async function PublicEventPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const r = await getPublicEvent(await getDriver(), ref);
  if (!r) notFound();
  const { event: e, updates } = r;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/events">← All events</Link></p>
      <h1 className="mt-2 text-3xl">{e.name}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><EventStatusBadge status={e.status} /><span>{EVENT_CATEGORY_LABELS[e.category]}</span>
        <span className="text-muted">{e.countyName} County · ZIP {e.zips.join(", ")} · {e.startDate}{e.endDate ? ` to ${e.endDate}` : ""}</span></div>
      <p className="mt-3">{e.summary}</p>
      {updates.length > 0 && (
        <section className="card mt-5 p-4" aria-labelledby="updates"><h2 id="updates" className="text-xl">Updates</h2>
          <ol className="mt-2 grid gap-3">{updates.map((u) => <li key={u.id} className="border-l-4 border-gold pl-3 text-sm"><time className="text-xs text-muted" dateTime={u.at.toISOString()}>{u.at.toLocaleDateString("en-US", { dateStyle: "medium" })}</time><p className="whitespace-pre-wrap">{u.body}</p></li>)}</ol></section>
      )}
      <p className="mt-6 text-sm">Want to help? <Link className="underline" href="/volunteer">Volunteer or donate</Link> · <Link className="underline" href="/projects">See community projects</Link></p>
    </div>
  );
}
