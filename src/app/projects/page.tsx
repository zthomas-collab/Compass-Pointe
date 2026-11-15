import type { Metadata } from "next";
import Link from "next/link";
import { PROJECT_AUDIENCE_LABELS } from "@/lib/projects";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listCounties } from "@/server/modules/counties";
import { DEFAULT_RADIUS_MILES, RADIUS_OPTIONS_MILES } from "@/server/modules/directory";
import { searchProjects, type PublicProject } from "@/server/modules/projects";

export const metadata: Metadata = { title: "Volunteer projects" };
export const dynamic = "force-dynamic";

type Search = { q?: string; zip?: string; radius?: string; countyId?: string };

/** Public list of local, need-based volunteer projects. No sign-in. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const db = await getDriver();
  const counties = await listCounties(db);
  let result: { projects: PublicProject[]; zip: string | null; radiusMiles: number } | null = null;
  let error: string | null = null;
  try {
    result = await searchProjects(db, query);
  } catch (err) {
    if (err instanceof AppError && err.code === "VALIDATION") error = err.fieldErrors ? Object.values(err.fieldErrors).flat().join(", ") : err.message;
    else throw err;
  }
  const filtering = Boolean(query.q || query.zip || query.countyId);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Volunteer projects</h1>
      <p className="mt-1 text-sm text-muted">Local needs posted by approved organizations. Each project lists the volunteer roles that need filling.</p>

      <form method="get" className="card mt-4 grid gap-3 p-4 sm:grid-cols-[1fr_8rem_9rem_auto] sm:items-end">
        <label className="field sm:col-span-4"><span>Search</span>
          <input className="input" name="q" defaultValue={query.q ?? ""} maxLength={100} placeholder="debris, roofing, meals…" /></label>
        <label className="field"><span>Near ZIP code</span>
          <input className="input" name="zip" inputMode="numeric" maxLength={5} defaultValue={query.zip ?? ""} placeholder="28801" /></label>
        <label className="field"><span>Within</span>
          <select className="input" name="radius" defaultValue={query.radius ?? String(DEFAULT_RADIUS_MILES)}>
            {RADIUS_OPTIONS_MILES.map((m) => <option key={m} value={m}>{m} miles</option>)}
          </select></label>
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={query.countyId ?? ""}>
            <option value="">All counties</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
          </select></label>
        <div className="flex gap-2">
          <button className="btn btn-primary" type="submit">Search</button>
          {filtering && <Link className="btn btn-secondary" href="/projects">Clear</Link>}
        </div>
      </form>

      {error && <p role="alert" className="mt-4 rounded-md bg-bad-bg p-3 text-sm text-bad">{error}</p>}

      {result && (
        <ul className="mt-5 grid gap-3" aria-label="Projects">
          {result.projects.map((p) => (
            <li key={p.id} className="card p-4">
              <Link className="text-lg font-semibold text-brand underline" href={`/projects/${p.id}`}>{p.title}</Link>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                {p.hasUrgent && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent need</span>}
                <span className={`badge ${p.spotsLeft > 0 ? "tone-brand" : "tone-muted"}`}>
                  {p.needs.length > 0 && p.needs.every((n) => n.ended)
                    ? "Shifts ended"
                    : p.spotsLeft > 0 ? `${p.spotsLeft} of ${p.totalSlots} spots left` : `Full (${p.totalSlots} of ${p.totalSlots})`}
                </span>
                <span className="text-muted">{p.orgName} · {p.countyName}, {p.state} {p.zip}
                  {p.distanceMiles !== null && <> · {p.distanceMiles} mi away</>}</span>
              </p>
              <p className="mt-2 line-clamp-3 text-sm">{p.description}</p>
              <p className="mt-1 text-xs text-muted">{PROJECT_AUDIENCE_LABELS[p.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? p.audience}</p>
            </li>
          ))}
          {result.projects.length === 0 && (
            <li className="text-sm text-muted">{filtering ? "No open projects match your search." : "No projects are open right now."}</li>
          )}
        </ul>
      )}
    </div>
  );
}
