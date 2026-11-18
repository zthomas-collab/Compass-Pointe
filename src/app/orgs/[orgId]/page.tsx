/* eslint-disable @next/next/no-img-element -- same-origin logo route; fixed small size */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { getPublicOrganization, listServiceTypes } from "@/server/modules/directory";
import { SOCIAL_KINDS, SOCIAL_LABELS, prettyUrl } from "@/lib/links";
import { telHref } from "@/lib/domain";
import { ServiceBadge } from "@/components/service-forms";
import { SyntheticBadge } from "@/components/status";
import { AcceptsLine, GiveActions } from "@/components/give-card";
import { EventStatusBadge } from "@/components/event-status";
import { getPublicOrganizationActivity } from "@/server/modules/org-activity";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { orgId } = await params;
  const org = await getPublicOrganization(await getDriver(), orgId);
  return { title: org ? org.displayName : "Organization not found" };
}

/** Public organization profile. Only approved, consented, administrator-approved profiles resolve. */
export default async function PublicOrganizationPage({ params }: Params) {
  const { orgId } = await params;
  const db = await getDriver();
  const [org, serviceTypes, activity] = await Promise.all([
    getPublicOrganization(db, orgId), listServiceTypes(db), getPublicOrganizationActivity(db, orgId),
  ]);
  if (!org) notFound();
  const typeOf = (code: string) => serviceTypes.find((t) => t.code === code);
  const primary = { label: org.serviceLabel, shortLabel: org.serviceShort, color: org.serviceColor };
  const socials = SOCIAL_KINDS.filter((k) => org.socialLinks[k]);
  const canGive = org.acceptedOfferTypes.length > 0 || Boolean(org.donationUrl);
  const hasContact = Boolean(org.website || org.publicPhone || org.publicEmail || socials.length || org.publicPostalCode);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <Link href="/contacts" className="text-sm text-brand underline">← Organizations</Link>

      <header className="card mt-3 p-5">
        <div className="flex flex-wrap items-center gap-4">
          {org.hasLogo && (
            <img src={`/api/orgs/${org.id}/logo`} alt={org.logoAlt ?? `${org.displayName} logo`} width={72} height={72}
              className="h-[72px] w-[72px] rounded-lg border border-line bg-white object-contain" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold sm:text-3xl">{org.displayName}</h1>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="badge tone-ok">Verified organization</span>
              <SyntheticBadge show={org.isSynthetic} />
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <ServiceBadge type={primary} />
          {org.additionalServiceTypes.map((c) => typeOf(c) && <ServiceBadge key={c} type={typeOf(c)!} />)}
        </div>
        {org.description && <p className="mt-4 max-w-3xl whitespace-pre-wrap">{org.description}</p>}
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid content-start gap-5">
          {canGive && (
            <section className="card grid gap-2 p-5" aria-labelledby="give-h">
              <h2 id="give-h" className="text-xl">How to help</h2>
              <AcceptsLine types={org.acceptedOfferTypes} />
              <GiveActions org={{ orgId: org.id, displayName: org.displayName, acceptedOfferTypes: org.acceptedOfferTypes, donationUrl: org.donationUrl }} />
            </section>
          )}

          {activity.projects.length > 0 && (
            <section className="card p-5" aria-labelledby="projects-h">
              <h2 id="projects-h" className="text-xl">Volunteer projects</h2>
              <ul className="mt-2 divide-y divide-line">
                {activity.projects.map((p) => (
                  <li key={p.id} className="py-2">
                    <Link className="font-semibold text-brand underline" href={`/volunteer/projects/${p.id}`}>{p.title}</Link>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      {p.hasUrgent && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
                      <span>{p.countyName}, {p.state}</span>
                      <span>{p.spotsLeft > 0 ? `${p.spotsLeft} ${p.spotsLeft === 1 ? "spot" : "spots"} left` : "Full"}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="grid content-start gap-5">
          {(org.countiesServed.length > 0 || activity.sites.length > 0) && (
            <section className="card p-5" aria-labelledby="where-h">
              <h2 id="where-h" className="text-xl">Where we work</h2>
              {org.countiesServed.length > 0 && (
                <p className="mt-1 text-sm"><span className="font-semibold">Counties served:</span> {org.countiesServed.join("; ")}</p>
              )}
              {activity.sites.length > 0 && (
                <ul className="mt-2 grid gap-1 text-sm">
                  {activity.sites.map((s) => (
                    <li key={s.id}>
                      <Link className="text-brand underline" href={`/?site=${s.id}`}>{s.name}</Link>
                      {(s.city || s.state) && <span className="text-muted"> · {[s.city, s.state].filter(Boolean).join(", ")}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {activity.events.length > 0 && (
            <section className="card p-5" aria-labelledby="events-h">
              <h2 id="events-h" className="text-xl">Responding to</h2>
              <ul className="mt-2 grid gap-1 text-sm">
                {activity.events.map((e) => (
                  <li key={e.slug} className="flex flex-wrap items-center gap-2">
                    <Link className="text-brand underline" href={`/events/${e.slug}`}>{e.name}</Link>
                    <EventStatusBadge status={e.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hasContact && (
            <section className="card p-5" aria-labelledby="contact-h">
              <h2 id="contact-h" className="text-xl">Contact</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {org.website && (
                  <a className="btn btn-primary" href={org.website} target="_blank" rel="noopener noreferrer nofollow">
                    Visit website <span className="sr-only">(opens in a new tab)</span>
                  </a>
                )}
                {org.publicPhone && <a className="btn btn-secondary" href={telHref(org.publicPhone)}>Call {org.publicPhone}</a>}
                {org.publicEmail && <a className="btn btn-secondary" href={`mailto:${org.publicEmail}`}>Email</a>}
              </div>
              {socials.length > 0 && (
                <ul className="mt-3 grid gap-1 text-sm">
                  {socials.map((k) => (
                    <li key={k}>
                      <a className="text-brand underline" href={org.socialLinks[k]} target="_blank" rel="noopener noreferrer nofollow">
                        {SOCIAL_LABELS[k]}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                      <span className="ml-1 text-xs text-muted">{prettyUrl(org.socialLinks[k]!)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {org.publicPostalCode && <p className="mt-3 text-sm"><span className="text-muted">Office ZIP:</span> {org.publicPostalCode}</p>}
            </section>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted">
        This profile is provided by the organization. External links open sites we do not control. In an emergency, call 911.
      </p>
    </div>
  );
}
