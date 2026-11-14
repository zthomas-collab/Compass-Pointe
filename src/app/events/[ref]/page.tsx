import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DirectionsMenu } from "@/components/DirectionsMenu";
import { EventStatusBadge } from "@/components/event-ui";
import { PriorityBadge, ProgressBar } from "@/components/project-ui";
import { StatusPill } from "@/components/status-icons";
import { displayAvailability, telHref, type AvailabilityStatus, type Freshness } from "@/lib/domain";
import { getDriver } from "@/server/db";
import { EVENT_CATEGORY_LABELS, getPublicEvent, getPublicEventArea, type AreaNeed } from "@/server/modules/events";

export const metadata: Metadata = { title: "Event" };
export const dynamic = "force-dynamic";

type View = "both" | "needs" | "resources";
const n = (v: number) => v.toLocaleString("en-US");
const give = (zip: string, need?: AreaNeed) =>
  `/volunteer?${new URLSearchParams({ zip, ...(need ? { type: need.category, project: need.projectTitle } : {}) }).toString()}`;

export default async function PublicEventPage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ view?: string; zip?: string }> }) {
  const { ref } = await params;
  const sp = await searchParams;
  const db = await getDriver();
  const r = await getPublicEvent(db, ref);
  if (!r) notFound();
  const { event: e, updates } = r;
  const view: View = sp.view === "needs" || sp.view === "resources" ? sp.view : "both";
  const area = await getPublicEventArea(db, ref, { zip: sp.zip });
  const zip = sp.zip && area?.zips.includes(sp.zip) ? sp.zip : undefined;
  const q = (over: { view?: View; zip?: string | null }) => {
    const p = new URLSearchParams();
    const v = over.view ?? view;
    const z = over.zip === null ? undefined : over.zip ?? zip;
    if (v !== "both") p.set("view", v);
    if (z) p.set("zip", z);
    const s = p.toString();
    return `/events/${e.reference}${s ? `?${s}` : ""}#area`;
  };
  const tab = (on: boolean) => `rounded-md border px-4 py-2 text-sm font-semibold ${on ? "border-brand bg-brand text-white" : "border-line bg-surface"}`;
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-gold bg-gold text-ink" : "border-line bg-surface"}`;
  const firstZip = zip ?? area?.zips[0] ?? e.zips[0];
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/events">← All events</Link></p>
      <h1 className="mt-2 text-3xl">{e.name}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><EventStatusBadge status={e.status} /><span>{EVENT_CATEGORY_LABELS[e.category]}</span>
        <span className="text-muted">{e.countyName} County · ZIP {e.zips.join(", ")} · {e.startDate}{e.endDate ? ` to ${e.endDate}` : ""}</span></div>
      <p className="mt-3">{e.summary}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link className="btn btn-attention" href={give(firstZip)}>Donate or volunteer</Link>
        <Link className="btn btn-primary" href={`/assistance/new?zip=${firstZip}`}>Request help</Link>
        <Link className="btn btn-secondary" href="/contacts">Find an organization</Link>
      </div>

      {area && (
        <section id="area" className="mt-8 scroll-mt-24" aria-labelledby="area-h">
          <h2 id="area-h" className="text-2xl">Needs and resources in this area</h2>
          <p className="mt-1 text-sm text-muted">Current unmet needs come from projects coordinators have published. Resources are the publicly listed places where help is available. Always check the time each listing was last confirmed.</p>

          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Show">
            <Link className={tab(view === "both")} href={q({ view: "both" })} aria-current={view === "both" ? "page" : undefined}>Needs and resources</Link>
            <Link className={tab(view === "needs")} href={q({ view: "needs" })} aria-current={view === "needs" ? "page" : undefined}>Current needs ({area.totals.openNeeds})</Link>
            <Link className={tab(view === "resources")} href={q({ view: "resources" })} aria-current={view === "resources" ? "page" : undefined}>Resources ({area.totals.resources})</Link>
          </nav>
          <nav className="mt-3 flex flex-wrap items-center gap-2" aria-label="ZIP code">
            <span className="text-sm font-semibold">ZIP code:</span>
            <Link className={chip(!zip)} href={q({ zip: null })} aria-current={!zip ? "page" : undefined}>All</Link>
            {area.zips.map((z) => <Link key={z} className={chip(zip === z)} href={q({ zip: z })} aria-current={zip === z ? "page" : undefined}>{z}</Link>)}
          </nav>

          <div className="mt-5 grid gap-6">
            {area.needsByZip.map((nz) => {
              const rz = area.resourcesByZip.find((x) => x.zip === nz.zip)!;
              return (
                <article key={nz.zip} className="card p-4" aria-labelledby={`z-${nz.zip}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id={`z-${nz.zip}`} className="text-xl">ZIP {nz.zip}</h3>
                    <div className="flex flex-wrap gap-2 text-sm">
                      <Link className="underline" href={give(nz.zip)}>Donate or volunteer here</Link><span aria-hidden>·</span>
                      <Link className="underline" href={`/assistance/new?zip=${nz.zip}`}>Request help here</Link>
                    </div>
                  </div>

                  {view !== "resources" && (
                    <section className="mt-4" aria-label={`Current needs in ${nz.zip}`}>
                      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted">Current needs</h4>
                      {nz.needs.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">{nz.metCount > 0 ? `All ${nz.metCount} listed need${nz.metCount === 1 ? " has" : "s have"} been met for now.` : "No needs are listed for this ZIP code right now."} You can still <Link className="underline" href={give(nz.zip)}>offer help</Link>.</p>
                      ) : (
                        <ul className="mt-2 grid gap-3">
                          {nz.needs.map((need, i) => (
                            <li key={i} className="rounded-lg border border-line p-3">
                              <div className="flex flex-wrap items-center gap-2"><strong>{need.label}</strong><PriorityBadge priority={need.priority} /></div>
                              <p className="mt-1 text-sm"><strong>{n(need.remaining)} {need.unit}</strong> still needed <span className="text-muted">({n(need.verified)} of {n(need.requested)} confirmed delivered)</span></p>
                              <div className="mt-2 max-w-sm"><ProgressBar percent={need.percent} label={`${need.label} progress`} /></div>
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                                <Link className="btn btn-attention min-h-9 px-3 py-1" href={give(nz.zip, need)}>Donate or volunteer for this</Link>
                                <Link className="underline" href={`/projects/${need.projectReference}`}>About this project</Link>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      {nz.needs.length > 0 && nz.metCount > 0 && <p className="mt-2 text-xs text-muted">{nz.metCount} other need{nz.metCount === 1 ? " has" : "s have"} already been met.</p>}
                    </section>
                  )}

                  {view !== "needs" && (
                    <section className="mt-5" aria-label={`Resources in ${nz.zip}`}>
                      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted">Resources available</h4>
                      {rz.sites.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">No resource sites are publicly listed in this ZIP code. Try <Link className="underline" href="/">the resource map</Link> or call 211.</p>
                      ) : (
                        <ul className="mt-2 grid gap-3">
                          {rz.sites.map((s) => (
                            <li key={s.id} className="rounded-lg border border-line p-3">
                              <div className="font-semibold">{s.name}</div>
                              <div className="text-sm text-muted">{s.orgName}{s.serviceLabel ? ` · ${s.serviceLabel}` : ""}</div>
                              {(s.address || s.city) && <div className="mt-1 text-sm">{[s.address, s.city, s.state].filter(Boolean).join(", ")}</div>}
                              {s.hours && <div className="text-sm">Hours: {s.hours}</div>}
                              {s.resources.length > 0 && (
                                <ul className="mt-2 grid gap-1">
                                  {s.resources.map((res) => {
                                    const d = displayAvailability(res.status as AvailabilityStatus, res.freshness as Freshness);
                                    return (
                                      <li key={res.id} className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="font-medium">{res.name}</span><span className="text-xs text-muted">{res.category}</span>
                                        <StatusPill kind={d.kind} label={d.label} />
                                        {res.quantity !== null && <span className="text-xs">{n(res.quantity)} {res.unit}</span>}
                                        {d.note && <span className="text-xs text-muted">{d.note}</span>}
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                {s.phone && <a className="btn btn-primary min-h-9 px-3 py-1" href={telHref(s.phone)}>Call {s.phone}</a>}
                                <DirectionsMenu lat={s.lat} lng={s.lng} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </article>
              );
            })}
          </div>
          <p className="mt-4 rounded-md bg-bad-bg p-3 text-sm text-bad"><strong>Life-threatening emergency? Call 911.</strong> Listings are provided by participating organizations and are not official notices. Need other help? Dial 211.</p>
        </section>
      )}

      {updates.length > 0 && (
        <section className="card mt-8 p-4" aria-labelledby="updates"><h2 id="updates" className="text-xl">Updates</h2>
          <ol className="mt-2 grid gap-3">{updates.map((u) => <li key={u.id} className="border-l-4 border-gold pl-3 text-sm"><time className="text-xs text-muted" dateTime={u.at.toISOString()}>{u.at.toLocaleDateString("en-US", { dateStyle: "medium" })}</time><p className="whitespace-pre-wrap">{u.body}</p></li>)}</ol></section>
      )}
      <p className="mt-6 text-sm">See all <Link className="underline" href="/projects">community projects</Link> · <Link className="underline" href="/learn">learn how to prepare and recover</Link></p>
    </div>
  );
}
