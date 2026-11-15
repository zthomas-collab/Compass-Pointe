import type { Metadata } from "next";
import Link from "next/link";
import { DonateChooser } from "@/components/donate-chooser";
import { OfferForm } from "@/components/offer-forms";
import { Breadcrumb, VolunteerSectionNav } from "@/components/volunteer-nav";
import { OFFER_TYPES, OFFER_TYPE_INFO, OFFER_TYPE_LABELS, donateViewFor } from "@/lib/offers";
import { VOLUNTEER_PATHS } from "@/lib/volunteer-paths";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { submitOfferAction } from "../actions";

export const metadata: Metadata = { title: "Donate supplies, equipment or space" };
export const dynamic = "force-dynamic";

/**
 * Donate: first choose what you are giving, then a short form with that choice already selected.
 * The choice travels in the address (?type=FOOD), so it works without JavaScript and can be linked to.
 */
export default async function DonatePage({ searchParams }: { searchParams: Promise<{ type?: string | string[] }> }) {
  const { type } = await searchParams;
  const view = donateViewFor(type);

  if (view.mode === "chooser") {
    return (
      <>
        <VolunteerSectionNav current="donate" />
        <div className="mx-auto w-full max-w-4xl px-4 py-6">
          <Breadcrumb items={[{ label: "Volunteer & donate", href: VOLUNTEER_PATHS.hub }, { label: "Donate" }]} />
          <h1 className="mt-2 text-3xl">What would you like to give?</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Choose what you can offer. A short form follows. Coordinators review every offer and match it to a real need; you do not
            need an account, and sending an offer does not commit anyone to accept it.
          </p>
          <DonateChooser />
          <p className="mt-6 text-sm text-muted">
            Want to give time instead? <Link className="underline" href={VOLUNTEER_PATHS.shifts}>Find a volunteer shift</Link>.
          </p>
        </div>
      </>
    );
  }

  const info = OFFER_TYPE_INFO[view.type];
  const counties = await listCounties(await getDriver());
  return (
    <>
      <VolunteerSectionNav current="donate" />
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <Breadcrumb items={[
          { label: "Volunteer & donate", href: VOLUNTEER_PATHS.hub },
          { label: "Donate", href: VOLUNTEER_PATHS.donate },
          { label: OFFER_TYPE_LABELS[view.type] },
        ]} />
        <h1 className="mt-2 text-3xl">Donate: {OFFER_TYPE_LABELS[view.type]}</h1>
        <p className="mt-1 text-muted">{info.description}</p>
        <p className="mt-1 text-sm">
          <Link className="underline" href={VOLUNTEER_PATHS.donate}>Change what I&apos;m giving</Link>
        </p>

        {info.steerToShifts && (
          <aside className="card mt-5 border-brand p-4" aria-labelledby="shifts-h">
            <h2 id="shifts-h" className="text-lg font-semibold">The fastest way to help is a real shift</h2>
            <p className="mt-1 text-sm text-muted">
              Organizations post specific shifts with a place and a time. Sign up in a minute and you will be confirmed by email.
            </p>
            <p className="mt-3"><Link className="btn btn-primary" href={VOLUNTEER_PATHS.shifts}>Find a volunteer shift</Link></p>
            <p className="mt-3 text-sm text-muted">Or tell us about your skills below and a coordinator will look for a fit.</p>
          </aside>
        )}

        <div className="card mt-5 p-4">
          <OfferForm
            action={submitOfferAction}
            counties={counties}
            types={OFFER_TYPES.map((t) => ({ code: t, label: OFFER_TYPE_LABELS[t] }))}
            defaultType={view.type}
            typeHints={{ quantityHint: info.quantityHint, unitHint: info.unitHint }}
          />
        </div>
      </div>
    </>
  );
}
