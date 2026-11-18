import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SignUpForm } from "@/components/signup-forms";
import { Breadcrumb, VolunteerSectionNav } from "@/components/volunteer-nav";
import { PROJECT_AUDIENCE_LABELS } from "@/lib/projects";
import { formatShift } from "@/lib/shift";
import { VOLUNTEER_PATHS, donatePath } from "@/lib/volunteer-paths";
import { signUpAction } from "../signup-actions";
import { getDriver } from "@/server/db";
import { getPublicOrganization } from "@/server/modules/directory";
import { listPublicProjectEvents } from "@/server/modules/eventlinks";
import { getPublicProject } from "@/server/modules/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

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
  const events = await listPublicProjectEvents(db, project.id);
  return (
    <>
    <VolunteerSectionNav current="shifts" />
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Breadcrumb items={[
        { label: "Volunteer & donate", href: VOLUNTEER_PATHS.hub },
        { label: "Find a shift", href: VOLUNTEER_PATHS.shifts },
        { label: project.title },
      ]} />
      <h1 className="mt-2 text-3xl">{project.title}</h1>
      <p className="mt-1 text-sm text-muted">
        {orgProfile ? <Link className="underline" href={`/orgs/${project.orgId}`}>{project.orgName}</Link> : project.orgName}
        {" · "}{project.countyName}, {project.state} {project.zip}
        {" · "}{PROJECT_AUDIENCE_LABELS[project.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? project.audience}
        {project.siteId && project.sitePublic && (
          <>{" · "}<Link className="underline" href={`/?site=${project.siteId}`}>See it on the map</Link></>
        )}
      </p>
      {events.length > 0 && (
        <p className="mt-2 text-sm">
          Part of:{" "}
          {events.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ", "}
              <Link className="underline" href={`/events/${e.slug}`}>{e.name}</Link>{e.status === "CLOSED" ? " (closed)" : ""}
            </span>
          ))}
        </p>
      )}
      <p className="mt-4 whitespace-pre-line">{project.description}</p>

      <section className="mt-8" aria-labelledby="needs-h">
        <h2 id="needs-h" className="text-xl">Volunteer roles</h2>
        <ul className="mt-3 grid gap-3">
          {project.needs.map((n) => (
            <li key={n.id} className="card p-4">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {n.title}
                <span className={`badge ${n.spotsLeft > 0 ? "tone-brand" : "tone-muted"}`}>
                  {n.ended ? "Shift ended" : n.spotsLeft > 0 ? `${n.spotsLeft} of ${n.slotsNeeded} spots left` : `Full (${n.slotsNeeded} of ${n.slotsNeeded})`}
                </span>
                {n.urgency === "URGENT" && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
              </p>
              {formatShift(n.startsAt, n.endsAt) && <p className="text-sm text-muted">{formatShift(n.startsAt, n.endsAt)}</p>}
              {n.skills && <p className="text-sm text-muted">Skills or what to bring: {n.skills}</p>}
              {n.details && <p className="mt-1 whitespace-pre-line text-sm">{n.details}</p>}
              {n.spotsLeft > 0 && !n.ended ? (
                <div className="mt-3 border-t border-line pt-3">
                  <SignUpForm action={signUpAction.bind(null, n.id)} orgName={project.orgName} />
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">{n.ended ? "This shift has ended." : "This role is full right now. Spots open up when someone cancels."}</p>
              )}
            </li>
          ))}
        </ul>
        {orgProfile && orgProfile.acceptedOfferTypes.length > 0 && (
          <p className="card mt-6 p-4 text-sm">
            Can&apos;t make a shift?{" "}
            <Link className="font-semibold underline" href={donatePath(undefined, project.orgId)}>Offer supplies to {project.orgName}</Link>
          </p>
        )}
        <p className="mt-6 text-sm">
          <Link className="underline" href={VOLUNTEER_PATHS.shifts}>← See all shifts</Link>
        </p>
      </section>
    </div>
    </>
  );
}
