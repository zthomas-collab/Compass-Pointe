import Link from "next/link";
import { getBrand } from "@/config/brand";
import { OFFER_TYPE_LABELS, type OfferType } from "@/lib/offers";
import { VOLUNTEER_PATHS, donatePath } from "@/lib/volunteer-paths";

export type GiveOrg = {
  orgId: string; displayName: string; acceptedOfferTypes: OfferType[]; donationUrl: string | null;
  openSpots?: number; countiesServed?: string[];
};

/** "Accepts: drinking water · food" or nothing when the organization takes no in-kind giving here. */
export function AcceptsLine({ types }: { types: OfferType[] }) {
  if (!types.length) return null;
  return <p className="text-sm"><span className="font-semibold">Accepts:</span> {types.map((t) => OFFER_TYPE_LABELS[t].toLowerCase()).join(" · ")}</p>;
}

/**
 * The ways to help one organization. Each button shows only when it applies: Offer supplies (it accepts some kind of
 * giving), Give money (an administrator approved its donation link; opens the organization's own page) and Volunteer.
 */
export function GiveActions({ org, volunteerHref }: { org: GiveOrg; volunteerHref?: string }) {
  const offer = org.acceptedOfferTypes.length > 0;
  const volunteer = (org.openSpots ?? 0) > 0;
  if (!offer && !org.donationUrl && !volunteer) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {offer && <Link className="btn btn-primary" href={donatePath(undefined, org.orgId)}>Offer supplies<span className="sr-only"> to {org.displayName}</span></Link>}
      {org.donationUrl && (
        <a className="btn btn-secondary" href={org.donationUrl} target="_blank" rel="noopener noreferrer nofollow">
          Give money <span aria-hidden="true">↗</span><span className="sr-only"> to {org.displayName} on their own website (opens in a new tab)</span>
        </a>
      )}
      {volunteer && <Link className="btn btn-secondary" href={volunteerHref ?? VOLUNTEER_PATHS.shifts}>Volunteer<span className="sr-only"> with {org.displayName}</span></Link>}
    </div>
  );
}

/** One organization helping in an event: who it is, what it accepts, open volunteer spots, and how to help. */
export function GiveCard({ org, volunteerHref }: { org: GiveOrg; volunteerHref?: string }) {
  return (
    <div className="card grid gap-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link className="text-lg font-semibold text-brand underline" href={`/orgs/${org.orgId}`}>{org.displayName}</Link>
        {org.countiesServed && org.countiesServed.length > 0 && (
          <span className="text-sm text-muted">Serving: {org.countiesServed.join("; ")}</span>
        )}
      </div>
      <AcceptsLine types={org.acceptedOfferTypes} />
      {(org.openSpots ?? 0) > 0 && (
        <p className="text-sm"><span className="font-semibold">Volunteer:</span> {org.openSpots} {org.openSpots === 1 ? "spot" : "spots"} open</p>
      )}
      <GiveActions org={org} volunteerHref={volunteerHref} />
    </div>
  );
}

export type GiveMoneyEntry = { orgId: string; displayName: string; donationUrl: string; host: string; countiesServed: string[] };

/**
 * Organizations taking money donations, each with a button to its own (administrator-reviewed) donation page.
 * The platform never handles money, and says so. Renders nothing when no organization has an approved link,
 * so a visitor never meets an empty list.
 */
export function GiveMoneySection({ orgs, limit, moreHref, headingLevel = 2 }: {
  orgs: GiveMoneyEntry[]; limit?: number; moreHref?: string; headingLevel?: 2 | 3;
}) {
  if (!orgs.length) return null;
  const shown = limit ? orgs.slice(0, limit) : orgs;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section id="give-money" className="card scroll-mt-4 p-5" aria-labelledby="give-money-h">
      <Heading id="give-money-h" className="text-2xl">Give money</Heading>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Donate directly to a verified organization on its own website. An administrator reviewed each link.{" "}
        {getBrand().name} never handles or keeps your money.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {shown.map((o) => (
          <li key={o.orgId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3">
            <span className="min-w-0">
              <Link className="block font-semibold text-brand underline" href={`/orgs/${o.orgId}`}>{o.displayName}</Link>
              <span className="block text-sm text-muted">
                {o.countiesServed.length > 0 ? `Serving ${o.countiesServed.join("; ")} · ` : ""}{o.host}
              </span>
            </span>
            <a className="btn btn-primary" href={o.donationUrl} target="_blank" rel="noopener noreferrer nofollow">
              Donate <span aria-hidden="true">↗</span><span className="sr-only"> to {o.displayName} on their own website (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
      {moreHref && shown.length < orgs.length && (
        <p className="mt-3 text-sm"><Link className="underline" href={moreHref}>See all {orgs.length} organizations taking donations</Link></p>
      )}
    </section>
  );
}
