import Link from "next/link";
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
