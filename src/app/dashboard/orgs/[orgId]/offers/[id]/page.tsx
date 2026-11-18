import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OfferNoteForm, OfferTransitionForm } from "@/components/offer-forms";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { OFFER_STATUS_LABELS, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import { getOrgOffer } from "@/server/modules/org-offers";
import { requireUser } from "@/server/session";
import { orgOfferNoteAction, orgOfferTransitionAction } from "../actions";

export const metadata: Metadata = { title: "Offer", robots: { index: false } };
export const dynamic = "force-dynamic";
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

const ORG_LABELS: Record<string, string> = {
  ACCEPTED: "Accept: we can use this", DECLINED: "Decline: we can't use this", SCHEDULED: "Scheduled: pickup or delivery is arranged",
  COMPLETED: "Received / completed", CANCELED: "Cancel",
};

/** One offer sent to this organization, with the giver's contact details. Opening it is recorded in the audit log. */
export default async function OrgOfferPage({ params }: { params: Promise<{ orgId: string; id: string }> }) {
  const user = await requireUser();
  const { orgId, id } = await params;
  let o;
  try {
    o = await getOrgOffer(await getDriver(), user.id, orgId, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href={`/dashboard/orgs/${orgId}/offers`}>← All offers</Link></p>
      <h1 className="mt-2 text-3xl">{OFFER_TYPE_LABELS[o.contributionType]} from {o.contributorName}</h1>
      <p className="mt-1"><span className="badge tone-brand">{OFFER_STATUS_LABELS[o.status]}</span> <span className="font-mono text-sm">{o.reference}</span></p>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="offer">
            <h2 id="offer" className="text-xl">Offer</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{o.description}</p>
            <dl className="mt-3 grid gap-1 text-sm">
              {o.quantity !== null && <div><dt className="inline font-semibold">Quantity: </dt><dd className="inline">{o.quantity}{o.unit ? ` ${o.unit}` : ""}</dd></div>}
              <div><dt className="inline font-semibold">Giver&apos;s ZIP: </dt><dd className="inline">{o.zip}</dd></div>
              {(o.availableFrom || o.availableUntil) && <div><dt className="inline font-semibold">Available: </dt><dd className="inline">{o.availableFrom ?? "now"} to {o.availableUntil ?? "open-ended"}</dd></div>}
              {o.deliveryNotes && <div><dt className="inline font-semibold">Pickup/delivery: </dt><dd className="inline">{o.deliveryNotes}</dd></div>}
              {o.preferredProject && <div><dt className="inline font-semibold">Project they would like to support: </dt><dd className="inline">{o.preferredProject}</dd></div>}
            </dl>
          </section>
          <section className="card p-4" aria-labelledby="who">
            <h2 id="who" className="text-xl">Contact the giver</h2>
            <p className="mt-1 text-xs text-muted">They agreed to share these details with your organization for this offer only.</p>
            <dl className="mt-2 grid gap-1 text-sm">
              <div><dt className="inline font-semibold">Name: </dt><dd className="inline">{o.contributorName}</dd></div>
              {o.organizationName && <div><dt className="inline font-semibold">Their organization: </dt><dd className="inline">{o.organizationName}</dd></div>}
              <div><dt className="inline font-semibold">Email: </dt><dd className="inline"><a className="underline" href={`mailto:${o.email}`}>{o.email}</a></dd></div>
              {o.phone && <div><dt className="inline font-semibold">Phone: </dt><dd className="inline"><a className="underline" href={`tel:${o.phone}`}>{o.phone}</a></dd></div>}
            </dl>
          </section>
          <section className="card p-4" aria-labelledby="hist">
            <h2 id="hist" className="text-xl">History</h2>
            <ol className="mt-3 grid gap-3">
              {o.events.map((e) => (
                <li key={e.id} className="border-l-4 border-gold pl-3 text-sm">
                  <strong>{e.toStatus ? OFFER_STATUS_LABELS[e.toStatus as keyof typeof OFFER_STATUS_LABELS] ?? e.toStatus : e.type === "NOTE" ? "Note" : e.type}</strong>{" "}
                  <span className="text-xs text-muted">{e.actorRole === "ORG" ? "your organization" : e.actorRole.toLowerCase().replace(/_/g, " ")} · {fmt(e.at)}</span>
                  {e.note && <p className="mt-1 whitespace-pre-wrap">{e.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="grid content-start gap-5">
          {o.allowedNext.length > 0 && (
            <section className="card p-4" aria-labelledby="move">
              <h2 id="move" className="text-xl">Update status</h2>
              <p className="mt-1 text-xs text-muted">Declining or canceling needs a short reason. It stays with your team; the giver is told only that you can&apos;t use it.</p>
              <div className="mt-3">
                <OfferTransitionForm action={orgOfferTransitionAction.bind(null, orgId)} offerId={o.id} options={o.allowedNext} labels={ORG_LABELS} />
              </div>
            </section>
          )}
          <section className="card p-4" aria-labelledby="note">
            <h2 id="note" className="text-xl">Add a note</h2>
            <div className="mt-3"><OfferNoteForm action={orgOfferNoteAction.bind(null, orgId)} offerId={o.id} /></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
