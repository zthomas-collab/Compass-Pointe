import type { Metadata } from "next";
import Link from "next/link";
import { DonateChooser } from "@/components/donate-chooser";
import { GiveMoneySection } from "@/components/give-card";
import { OfferForm } from "@/components/offer-forms";
import { Breadcrumb, VolunteerSectionNav } from "@/components/volunteer-nav";
import { OFFER_TYPES, OFFER_TYPE_INFO, OFFER_TYPE_LABELS, donateViewForOrg } from "@/lib/offers";
import { VOLUNTEER_PATHS, donatePath } from "@/lib/volunteer-paths";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { getGiveTarget, listGiveMoneyOrgs } from "@/server/modules/giving";
import { submitOfferAction } from "../actions";

export const metadata: Metadata = { title: "Donate money, supplies, equipment or space" };
export const dynamic = "force-dynamic";

type Search = { type?: string | string[]; org?: string | string[] };

/**
 * Donate: first choose what you are giving, then a short form with that choice already selected.
 * The choice travels in the address (?type=FOOD), so it works without JavaScript and can be linked to.
 * With ?org=<id> the offer goes to that organization: only the kinds of giving it accepts are offered. An organization
 * that can't take offers (unknown, hidden, suspended, accepting nothing) falls back to the normal chooser with a notice.
 */
export default async function DonatePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { type, org } = await searchParams;
  const db = await getDriver();
  const target = org === undefined ? null : await getGiveTarget(db, org);
  const orgUnavailable = org !== undefined && !target;
  const view = donateViewForOrg(type, { requested: org !== undefined, accepted: target?.acceptedOfferTypes ?? null });
  const donateHome = target ? donatePath(undefined, target.orgId) : VOLUNTEER_PATHS.donate;

  if (view.mode === "chooser") {
    const moneyOrgs = target ? [] : await listGiveMoneyOrgs(db);
    return (
      <>
        <VolunteerSectionNav current="donate" />
        <div className="mx-auto w-full max-w-4xl px-4 py-6">
          <Breadcrumb items={[{ label: "Volunteer & donate", href: VOLUNTEER_PATHS.hub }, { label: "Donate" }]} />
          {orgUnavailable && (
            <p className="card mt-3 border-warn p-3 text-sm" role="status">
              That organization isn&apos;t taking donations through Crisis Compass right now. You can still offer to our coordinators.
            </p>
          )}
          <h1 className="mt-2 text-3xl">{target ? `Give to ${target.displayName}` : "What would you like to give?"}</h1>
          <p className="mt-2 max-w-2xl text-muted">
            {target
              ? `Choose what you can offer. ${target.displayName} receives your offer and contacts you to arrange it. You do not need an account.`
              : "Choose what you can offer. A short form follows. Coordinators review every offer and match it to a real need; you do not need an account, and sending an offer does not commit anyone to accept it."}
          </p>
          {moneyOrgs.length > 0 && (
            <p className="mt-3 text-sm">
              Prefer to give money? <a className="underline" href="#give-money">See organizations taking donations</a>.
            </p>
          )}
          <DonateChooser allowedTypes={target?.acceptedOfferTypes} orgId={target?.orgId} />
          {moneyOrgs.length > 0 && <div className="mt-8"><GiveMoneySection orgs={moneyOrgs} /></div>}
          {target?.donationUrl && (
            <p className="mt-6 text-sm">
              Prefer to give money?{" "}
              <a className="underline" href={target.donationUrl} target="_blank" rel="noopener noreferrer nofollow">
                Donate on {target.displayName}&apos;s website<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          )}
          <p className="mt-6 text-sm text-muted">
            Want to give time instead? <Link className="underline" href={VOLUNTEER_PATHS.shifts}>Find a volunteer shift</Link>.
          </p>
        </div>
      </>
    );
  }

  const info = OFFER_TYPE_INFO[view.type];
  const counties = await listCounties(db);
  const types = (target?.acceptedOfferTypes ?? OFFER_TYPES).map((t) => ({ code: t, label: OFFER_TYPE_LABELS[t] }));
  return (
    <>
      <VolunteerSectionNav current="donate" />
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <Breadcrumb items={[
          { label: "Volunteer & donate", href: VOLUNTEER_PATHS.hub },
          { label: "Donate", href: donateHome },
          { label: OFFER_TYPE_LABELS[view.type] },
        ]} />
        <h1 className="mt-2 text-3xl">
          {target ? `Give ${OFFER_TYPE_LABELS[view.type].toLowerCase()} to ${target.displayName}` : `Donate: ${OFFER_TYPE_LABELS[view.type]}`}
        </h1>
        <p className="mt-1 text-muted">{info.description}</p>
        <p className="mt-1 text-sm">
          <Link className="underline" href={donateHome}>Change what I&apos;m giving</Link>
        </p>

        {info.steerToShifts && (
          <aside className="card mt-5 border-brand p-4" aria-labelledby="shifts-h">
            <h2 id="shifts-h" className="text-lg font-semibold">The fastest way to help is a real shift</h2>
            <p className="mt-1 text-sm text-muted">
              Organizations post specific shifts with a place and a time. Sign up in a minute and you will be confirmed by email.
            </p>
            <p className="mt-3"><Link className="btn btn-primary" href={VOLUNTEER_PATHS.shifts}>Find a volunteer shift</Link></p>
            <p className="mt-3 text-sm text-muted">
              {target ? `Or tell ${target.displayName} about your skills below.` : "Or tell us about your skills below and a coordinator will look for a fit."}
            </p>
          </aside>
        )}

        <div className="card mt-5 p-4">
          <OfferForm
            action={submitOfferAction}
            counties={counties}
            types={types}
            defaultType={view.type}
            typeHints={{ quantityHint: info.quantityHint, unitHint: info.unitHint }}
            organization={target ? { id: target.orgId, name: target.displayName } : undefined}
          />
        </div>
      </div>
    </>
  );
}
