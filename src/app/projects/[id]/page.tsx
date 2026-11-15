import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PROJECT_AUDIENCE_LABELS } from "@/lib/projects";
import { getDriver } from "@/server/db";
import { getPublicOrganization } from "@/server/modules/directory";
import { getPublicProject } from "@/server/modules/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const fmtShift = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const project = await getPublicProject(await getDriver(), id);
  return { title: project ? project.title : "Project not found" };
}

/** Public project page. Anything that is not an open project of an approved organization is a 404. */
export default async function ProjectPage({ params }: Params) {
  const { id } = await params;
  const db = await getDriver();
  const project = await getPublicProject(db, id);
  if (!project) notFound();
  // Link to the organization only when its public profile is live.
  const orgProfile = await getPublicOrganization(db, project.orgId);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href="/projects" className="text-sm text-brand underline">← All projects</Link>
      <h1 className="mt-2 text-3xl">{project.title}</h1>
      <p className="mt-1 text-sm text-muted">
        {orgProfile ? <Link className="underline" href={`/orgs/${project.orgId}`}>{project.orgName}</Link> : project.orgName}
        {" · "}{project.countyName}, {project.state} {project.zip}
        {" · "}{PROJECT_AUDIENCE_LABELS[project.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? project.audience}
      </p>
      <p className="mt-4 whitespace-pre-line">{project.description}</p>

      <section className="mt-8" aria-labelledby="needs-h">
        <h2 id="needs-h" className="text-xl">Volunteer roles</h2>
        <ul className="mt-3 grid gap-3">
          {project.needs.map((n) => (
            <li key={n.id} className="card p-4">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {n.title}
                <span className="badge tone-brand">{n.slotsNeeded} needed</span>
                {n.urgency === "URGENT" && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
              </p>
              {(n.startsAt || n.endsAt) && <p className="text-sm text-muted">{fmtShift(n.startsAt)} to {fmtShift(n.endsAt)} (Eastern Time)</p>}
              {n.skills && <p className="text-sm text-muted">Skills or what to bring: {n.skills}</p>}
              {n.details && <p className="mt-1 whitespace-pre-line text-sm">{n.details}</p>}
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-md bg-surface p-3 text-sm text-muted">
          Online volunteer sign-up is coming soon. Until then, contact the organization to offer your help.
        </p>
      </section>
    </div>
  );
}
