import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar, StatGrid } from "@/components/dashboard-ui";
import { ProgressBar } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { OFFER_TYPES, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import { STATUS_LABELS, type AppStatus } from "@/server/modules/assistance";
import { getDashboard } from "@/server/modules/reports";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Operations dashboard", robots: { index: false } };
export const dynamic = "force-dynamic";
type Search = { countyId?: string; category?: string; from?: string; to?: string };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  let d;
  try {
    d = await getDashboard(await getDriver(), user.id, sp);
  } catch (err) {
    if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">{err.message}</p>;
    throw err;
  }
  const m = d.metrics;
  const exec = d.scope === "EXECUTIVE";
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <h1 className="text-3xl">{exec ? "Executive dashboard" : "County dashboard"}</h1>
      <p className="mt-1 text-sm text-muted">
        {exec ? "All counties." : `Your counties: ${d.counties.map((c) => c.name).join(", ")}.`} Every figure is counted live from the database. New-request
        counts use the date range ({d.range.from} to {d.range.to}).
      </p>
      <FilterBar action="/admin/dashboard">
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={sp.countyId ?? ""}>
            <option value="">{exec ? "All counties" : "All my counties"}</option>
            {d.counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
          </select></label>
        <label className="field"><span>Resource type</span>
          <select className="input" name="category" defaultValue={sp.category ?? ""}>
            <option value="">All</option>
            {OFFER_TYPES.map((t) => <option key={t} value={t}>{OFFER_TYPE_LABELS[t]}</option>)}
          </select></label>
        <label className="field"><span>From</span><input className="input" type="date" name="from" defaultValue={sp.from ?? d.range.from} /></label>
        <label className="field"><span>To</span><input className="input" type="date" name="to" defaultValue={sp.to ?? d.range.to} /></label>
      </FilterBar>

      <div className="mt-5 grid gap-3">
        <StatGrid label="Operations" stats={[
          { label: "Active events", value: m.activeEvents, href: "/admin/events?status=ACTIVE" },
          { label: "Active counties", value: m.activeCounties, hint: "With an active event, project or open request" },
          { label: exec ? "Approved nonprofits" : "Participating nonprofits", value: m.approvedNonprofits, href: exec ? "/admin/organizations" : undefined },
          { label: "Completed projects", value: m.completedProjects, href: "/admin/projects?status=COMPLETED" },
        ]} />
        <StatGrid label="Assistance" stats={[
          { label: "New requests", value: m.newRequests, hint: `${d.range.from} to ${d.range.to}`, href: "/admin/applications" },
          { label: "Pending applications", value: m.pendingApplications, href: "/admin/applications?status=SUBMITTED", tone: m.pendingApplications ? "warn" : undefined },
          { label: "Open resource needs", value: m.openNeeds, href: "/admin/projects?status=ACTIVE", tone: m.openNeeds ? "warn" : undefined },
          { label: "Active deliveries", value: m.activeDeliveries, hint: `${m.awaitingVerification} awaiting verification` },
        ]} />
        <StatGrid label="Offers and resources" stats={[
          { label: "Outstanding donations", value: m.outstandingDonations, href: "/admin/offers" },
          { label: "Available volunteers", value: m.availableVolunteers, href: "/admin/offers?type=VOLUNTEER_LABOR" },
          { label: "Upcoming events (30 days)", value: m.upcomingEvents },
          { label: "Resource listings", value: m.resourceListings, hint: `${m.availableResourceListings} reported available` },
        ]} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="card p-4" aria-labelledby="short"><h2 id="short" className="text-xl">Largest open needs</h2>
          {d.shortfalls.length === 0 ? <p className="mt-2 text-sm text-muted">No open needs on active projects.</p> : (
            <ul className="mt-2 grid gap-3">
              {d.shortfalls.map((s, i) => (
                <li key={i} className="text-sm">
                  <Link className="font-semibold text-brand underline" href={`/admin/projects/${s.projectId}`}>{s.projectTitle}</Link>
                  <div>{s.need}: {s.verified.toLocaleString("en-US")} of {s.requested.toLocaleString("en-US")} {s.unit} verified</div>
                  <div className="mt-1 max-w-xs"><ProgressBar percent={Math.round((s.verified / s.requested) * 100)} label={`${s.need} verified`} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="apps"><h2 id="apps" className="text-xl">Applications by status</h2>
            {d.applicationsByStatus.length === 0 ? <p className="mt-2 text-sm text-muted">No applications.</p> : (
              <ul className="mt-2 grid gap-1 text-sm">
                {d.applicationsByStatus.map((a) => (
                  <li key={a.status} className="flex justify-between border-b border-line py-1"><span>{STATUS_LABELS[a.status as AppStatus] ?? a.status}</span><strong>{a.count}</strong></li>
                ))}
              </ul>
            )}
          </section>
          <section className="card p-4" aria-labelledby="up"><h2 id="up" className="text-xl">Upcoming and active events</h2>
            {d.upcoming.length === 0 ? <p className="mt-2 text-sm text-muted">None.</p> : (
              <ul className="mt-2 grid gap-1 text-sm">
                {d.upcoming.map((e) => (
                  <li key={e.id}><Link className="font-semibold text-brand underline" href={`/admin/events/${e.id}`}>{e.name}</Link> <span className="text-muted">{e.countyName} · {e.startDate}</span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
