import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PriorityBadge, ProgressBar, ProjectStatusBadge, typeLabel } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listManageableCounties } from "@/server/modules/counties";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, listProjects } from "@/server/modules/projects";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Community projects", robots: { index: false } };
export const dynamic = "force-dynamic";

type Search = { status?: string; countyId?: string; zip?: string };

export default async function ProjectsAdmin({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = await getDriver();
  let projects;
  try {
    projects = await listProjects(db, user.id, sp);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filters and try again.</p>;
    throw err;
  }
  const counties = await listManageableCounties(db, user.id).catch(() => []);
  const canCreate = counties.length > 0;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl">Community projects</h1>
        {canCreate && <Link className="btn btn-primary" href="/admin/projects/new">New project</Link>}
      </div>
      <form method="get" className="card mt-4 grid gap-3 p-4 sm:grid-cols-4">
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>
            {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}</select></label>
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={sp.countyId ?? ""}><option value="">Any</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}</select></label>
        <label className="field"><span>ZIP</span><input className="input" name="zip" defaultValue={sp.zip ?? ""} inputMode="numeric" maxLength={5} /></label>
        <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Filter</button></div>
      </form>
      <section className="card mt-4 p-4" aria-label="Projects">
        {projects.length === 0 ? <p className="text-sm text-muted">No projects yet.</p> : (
          <ul className="divide-y divide-line">
            {projects.map((p) => (
              <li key={p.id} className="py-3">
                <Link className="font-semibold text-brand underline" href={`/admin/projects/${p.id}`}>{p.title}</Link>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} />
                  <span>{typeLabel(p.category)}</span><span className="text-muted">{p.countyName} County · {p.zips.join(", ")}</span>
                  {p.visibility === "PUBLIC" && <span className="badge tone-ok">Public</span>}
                </div>
                <div className="mt-2 max-w-sm"><ProgressBar percent={p.percentVerified} label={`${p.title} progress`} /></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
