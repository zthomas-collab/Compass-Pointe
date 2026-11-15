import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addNeedAction,
  removeNeedAction,
  setProjectStatusAction,
  submitProjectAction,
  updateNeedAction,
  updateProjectAction,
} from "@/app/dashboard/projects/actions";
import { ActionButton, NeedForm, ProjectForm } from "@/components/project-forms";
import { ProjectStatusBadge } from "@/components/project-status";
import { PROJECT_AUDIENCE_LABELS, type ProjectStatus } from "@/lib/projects";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { getOrganizationProfile } from "@/server/modules/directory";
import { getProjectForEditor } from "@/server/modules/projects";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Project", robots: { index: false } };
export const dynamic = "force-dynamic";

const EDITABLE: ProjectStatus[] = ["DRAFT", "OPEN", "PAUSED"];
const fmtShift = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

export default async function ProjectEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const { created } = await searchParams;
  const user = await requireUser();
  const db = await getDriver();
  const project = await getProjectForEditor(db, user.id, id);
  if (!project) notFound();
  const editing = project.canEdit && EDITABLE.includes(project.status);
  let counties: Awaited<ReturnType<typeof listCounties>> = [];
  if (editing) {
    const served = (await getOrganizationProfile(db, user.id, project.orgId).catch(() => null))?.countyIds ?? [];
    counties = (await listCounties(db)).filter((c) => served.includes(c.id) || c.id === project.countyId);
  }
  const s = project.status;
  const act = (to: ProjectStatus) => setProjectStatusAction.bind(null, project.id, to);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href={`/dashboard/orgs/${project.orgId}/projects`} className="text-sm text-brand underline">← Projects</Link>
      <h1 className="mt-2 text-2xl font-bold">{project.title}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <ProjectStatusBadge status={s} />
        <span className="text-sm text-muted">{project.orgName} · {project.countyName}, {project.state} {project.zip}</span>
      </p>
      {created && <p role="status" className="mt-3 rounded-md bg-ok-bg p-3 text-sm text-ok">Draft created. Add at least one volunteer role, then send it for review.</p>}
      {project.reviewNote && s === "DRAFT" && (
        <p role="status" className="mt-3 rounded-md bg-warn-bg p-3 text-sm"><strong>Reviewer note:</strong> {project.reviewNote}</p>
      )}

      <section className="card mt-5 p-4" aria-labelledby="status-h">
        <h2 id="status-h" className="text-lg font-semibold">Status</h2>
        {s === "PENDING_REVIEW" && <p className="mt-1 text-sm text-muted">Waiting for a county administrator. You can edit again once it is approved or returned.</p>}
        {(s === "COMPLETED" || s === "CANCELLED") && <p className="mt-1 text-sm text-muted">This project is finished and cannot be changed.</p>}
        {(s === "OPEN" || s === "PAUSED") && (
          <p className="mt-1 text-sm text-muted">Changing the details or the volunteer roles of a published project sends it back for review, and it leaves the public list until approved again.</p>
        )}
        {project.canEdit && (
          <div className="mt-3 flex flex-wrap gap-3">
            {s === "DRAFT" && <ActionButton action={submitProjectAction.bind(null, project.id)} label="Send for review" className="btn btn-primary" />}
            {s === "OPEN" && <ActionButton action={act("PAUSED")} label="Pause (hide from the public)" />}
            {s === "PAUSED" && <ActionButton action={act("OPEN")} label="Resume" className="btn btn-primary" />}
            {(s === "OPEN" || s === "PAUSED") && <ActionButton action={act("COMPLETED")} label="Mark completed" />}
            {(s === "DRAFT" || s === "OPEN" || s === "PAUSED") && <ActionButton action={act("CANCELLED")} label="Cancel project" />}
          </div>
        )}
      </section>

      <section className="card mt-5 p-4" aria-labelledby="details-h">
        <h2 id="details-h" className="mb-2 text-lg font-semibold">Details</h2>
        {editing ? (
          <ProjectForm action={updateProjectAction.bind(null, project.id)} counties={counties} project={project} />
        ) : (
          <dl className="grid gap-1 text-sm">
            <div><dt className="inline font-medium">For:</dt> <dd className="inline">{PROJECT_AUDIENCE_LABELS[project.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? project.audience}</dd></div>
            <div className="mt-1 whitespace-pre-line">{project.description}</div>
            {project.privateLocationNotes && <div className="mt-1"><dt className="inline font-medium">Private location notes:</dt> <dd className="inline">{project.privateLocationNotes}</dd></div>}
          </dl>
        )}
      </section>

      <section className="mt-5" aria-labelledby="needs-h">
        <h2 id="needs-h" className="text-lg font-semibold">Volunteer roles ({project.needs.length})</h2>
        <ul className="mt-2 grid gap-3">
          {project.needs.map((n) => (
            <li key={n.id} className="card p-4">
              {editing ? (
                <>
                  <NeedForm action={updateNeedAction.bind(null, project.id, n.id)} need={n} submitLabel="Save role" />
                  <div className="mt-2"><ActionButton action={removeNeedAction.bind(null, project.id, n.id)} label="Remove this role" /></div>
                </>
              ) : (
                <div className="text-sm">
                  <p className="font-medium">{n.title} · {n.slotsNeeded} needed{n.urgency === "URGENT" ? " · urgent" : ""}</p>
                  {(n.startsAt || n.endsAt) && <p className="text-muted">{fmtShift(n.startsAt)} to {fmtShift(n.endsAt)} (Eastern Time)</p>}
                  {n.skills && <p className="text-muted">{n.skills}</p>}
                  {n.details && <p className="mt-1 whitespace-pre-line">{n.details}</p>}
                </div>
              )}
            </li>
          ))}
          {project.needs.length === 0 && <li className="text-sm text-muted">No volunteer roles yet.</li>}
        </ul>
        {editing && (
          <div className="card mt-3 p-4">
            <h3 className="mb-2 font-semibold">Add a volunteer role</h3>
            <NeedForm key={project.needs.length} action={addNeedAction.bind(null, project.id)} submitLabel="Add role" />
          </div>
        )}
      </section>
    </div>
  );
}
