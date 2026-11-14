import type { Metadata } from "next";
import Link from "next/link";
import { PriorityBadge, ProgressBar, ProjectStatusBadge, typeLabel } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { listPublicProjects } from "@/server/modules/projects";

export const metadata: Metadata = { title: "Community projects" };
export const dynamic = "force-dynamic";

export default async function PublicProjects({ searchParams }: { searchParams: Promise<{ zip?: string }> }) {
  const { zip } = await searchParams;
  const projects = await listPublicProjects(await getDriver(), { zip });
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Community projects</h1>
      <p className="mt-2 text-muted">Needs coordinators have verified, and how much has been confirmed delivered. Locations are shown by ZIP code only.</p>
      <form method="get" className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        <label className="field"><span>Search by ZIP code</span><input className="input" name="zip" defaultValue={zip ?? ""} inputMode="numeric" maxLength={5} pattern="[0-9]{5}" /></label>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <section className="mt-4 grid gap-4" aria-label="Projects">
        {projects.length === 0 ? <p className="text-sm text-muted">No public projects match.</p> : projects.map((p) => (
          <article key={p.id} className="card p-4">
            <h2 className="text-xl"><Link className="underline" href={`/projects/${p.reference}`}>{p.title}</Link></h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm"><ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} />
              <span>{typeLabel(p.category)}</span><span className="text-muted">{p.countyName} County · ZIP {p.zips.join(", ")}</span></div>
            <p className="mt-2 text-sm">{p.summary}</p>
            <div className="mt-3 max-w-sm"><ProgressBar percent={p.percentVerified} label={`${p.title} progress`} /></div>
          </article>
        ))}
      </section>
      <p className="mt-6 text-sm">Want to help? <Link className="underline" href="/volunteer">Volunteer or donate</Link>.</p>
    </div>
  );
}
