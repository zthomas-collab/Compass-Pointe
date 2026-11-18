import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { OFFER_STATUSES, OFFER_STATUS_LABELS, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import { listOrgOffers } from "@/server/modules/org-offers";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Offers to your organization", robots: { index: false } };
export const dynamic = "force-dynamic";

type Search = { status?: string; page?: string };
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Offers givers sent to this organization. Editors and administrators of an eligible organization only. */
export default async function OrgOffersPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<Search> }) {
  const user = await requireUser();
  const [{ orgId }, sp] = await Promise.all([params, searchParams]);
  let r;
  try {
    r = await listOrgOffers(await getDriver(), user.id, orgId, sp);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filter and try again.</p>;
    throw err;
  }
  const q = (over: Record<string, string>) => new URLSearchParams(Object.entries({ ...sp, ...over }).filter(([, v]) => v) as [string, string][]).toString();
  const open = (r.counts.MATCHED ?? 0) + (r.counts.ACCEPTED ?? 0) + (r.counts.SCHEDULED ?? 0);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/dashboard" className="text-sm text-brand underline">← Dashboard</Link>
      <h1 className="mt-2 text-3xl">Offers to your organization</h1>
      <p className="mt-1 text-sm text-muted">
        People who chose your organization on Crisis Compass. Accept what you can use and arrange it with them directly; decline the rest so they can
        give elsewhere. {open} open.
      </p>
      <form method="get" className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>
            {OFFER_STATUSES.map((s) => <option key={s} value={s}>{OFFER_STATUS_LABELS[s]}{r.counts[s] ? ` (${r.counts[s]})` : ""}</option>)}</select></label>
        <button className="btn btn-primary" type="submit">Filter</button>
      </form>
      <section className="card mt-4 p-4" aria-label="Offers">
        {r.rows.length === 0 ? (
          <p className="text-sm text-muted">No offers yet. Make sure your profile lists the offers you accept, so givers can choose you.</p>
        ) : (
          <ul className="divide-y divide-line">
            {r.rows.map((o) => (
              <li key={o.id} className="py-3">
                <Link className="font-semibold text-brand underline" href={`/dashboard/orgs/${orgId}/offers/${o.id}`}>
                  {OFFER_TYPE_LABELS[o.contributionType]}{o.quantity !== null ? `: ${o.quantity}${o.unit ? ` ${o.unit}` : ""}` : ""}
                </Link>{" "}
                <span className="badge tone-brand">{OFFER_STATUS_LABELS[o.status]}</span>
                <div className="mt-1 text-sm">From {o.contributorName} · ZIP {o.zip} · <span className="font-mono">{o.reference}</span></div>
                <time className="text-xs text-muted" dateTime={o.createdAt.toISOString()}>Received {fmt(o.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
        <nav className="mt-3 flex justify-between text-sm" aria-label="Pages">
          {r.page > 1 ? <Link className="underline" href={`?${q({ page: String(r.page - 1) })}`}>← Newer</Link> : <span />}
          {r.hasMore && <Link className="underline" href={`?${q({ page: String(r.page + 1) })}`}>Older →</Link>}
        </nav>
      </section>
    </div>
  );
}
