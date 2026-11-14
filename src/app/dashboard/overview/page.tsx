import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar, StatGrid } from "@/components/dashboard-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { getOrgDashboard } from "@/server/modules/reports";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Organization overview", robots: { index: false } };
export const dynamic = "force-dynamic";
type Search = { orgId?: string; from?: string; to?: string };

export default async function OrgOverview({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  let d;
  try {
    d = await getOrgDashboard(await getDriver(), user.id, { from: sp.from, to: sp.to }, sp.orgId);
  } catch (err) {
    if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">{err.message}</p>;
    throw err;
  }
  const m = d.metrics;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/dashboard">← Dashboard</Link></p>
      <h1 className="mt-2 text-3xl">{d.orgName}</h1>
      <p className="mt-1 text-sm text-muted">Live figures for your organization. Completed activity uses the date range ({d.range.from} to {d.range.to}).</p>
      <FilterBar action="/dashboard/overview">
        <label className="field"><span>Organization</span>
          <select className="input" name="orgId" defaultValue={d.orgId}>{d.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label className="field"><span>From</span><input className="input" type="date" name="from" defaultValue={sp.from ?? d.range.from} /></label>
        <label className="field"><span>To</span><input className="input" type="date" name="to" defaultValue={sp.to ?? d.range.to} /></label>
      </FilterBar>
      <div className="mt-5 grid gap-3">
        <StatGrid label="Current work" stats={[
          { label: "Resource listings", value: m.listings, hint: `${m.availableListings} reported available`, href: "/dashboard" },
          { label: "Assigned requests", value: m.assignedRequests, hint: "Referred with the applicant's consent" },
          { label: "Pending commitments", value: m.pendingCommitments, href: "/dashboard/commitments", tone: m.pendingCommitments ? "warn" : undefined },
          { label: "Active projects", value: m.activeProjects },
        ]} />
        <StatGrid label="Delivery and results" stats={[
          { label: "Scheduled deliveries", value: m.scheduledDeliveries, href: "/dashboard/commitments" },
          { label: "Completed commitments", value: m.completedCommitments },
          { label: "Verified quantity delivered", value: m.verifiedQuantity },
          { label: "Completed referrals", value: m.completedReferrals },
        ]} />
      </div>
      <section className="card mt-5 p-4" aria-labelledby="sched"><h2 id="sched" className="text-xl">Upcoming deliveries</h2>
        {d.scheduled.length === 0 ? <p className="mt-2 text-sm text-muted">Nothing scheduled.</p> : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {d.scheduled.map((s) => (
              <li key={s.commitmentId} className="py-2"><strong>{s.scheduledFor}</strong> · {s.projectTitle}: {s.need}, {s.quantity.toLocaleString("en-US")} <span className="text-xs text-muted">({s.status.toLowerCase()})</span></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
