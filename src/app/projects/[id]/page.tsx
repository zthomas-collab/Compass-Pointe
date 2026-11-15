import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SignUpForm } from "@/components/signup-forms";
import { PROJECT_AUDIENCE_LABELS } from "@/lib/projects";
import { signUpAction } from "../signup-actions";
import { getDriver } from "@/server/db";
import { getPublicOrganization } from "@/server/modules/directory";
import { getPublicProject } from "@/server/modules/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const fmtShift = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

/** True when a shift's end time has passed (the service refuses sign-ups for it, so the page hides the form). */
const hasEnded = (endsAt: string | null) => endsAt !== null && Date.parse(endsAt) <= Date.now();

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
                <span className={`badge ${n.spotsLeft > 0 ? "tone-brand" : "tone-muted"}`}>
                  {n.spotsLeft > 0 ? `${n.spotsLeft} of ${n.slotsNeeded} spots left` : `Full (${n.slotsNeeded} of ${n.slotsNeeded})`}
                </span>
                {n.urgency === "URGENT" && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
              </p>
              {(n.startsAt || n.endsAt) && <p className="text-sm text-muted">{fmtShift(n.startsAt)} to {fmtShift(n.endsAt)} (Eastern Time)</p>}
              {n.skills && <p className="text-sm text-muted">Skills or what to bring: {n.skills}</p>}
              {n.details && <p className="mt-1 whitespace-pre-line text-sm">{n.details}</p>}
              {n.spotsLeft > 0 && !hasEnded(n.endsAt) ? (
                <div className="mt-3 border-t border-line pt-3">
                  <SignUpForm action={signUpAction.bind(null, n.id)} orgName={project.orgName} />
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">{n.spotsLeft > 0 ? "This shift has ended." : "This role is full right now. Spots open up when someone cancels."}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
