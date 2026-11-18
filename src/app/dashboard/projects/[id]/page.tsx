import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addNeedAction,
  linkEventAction,
  markAttendanceAction,
  removeNeedAction,
  restoreEventAction,
  setProjectStatusAction,
  submitProjectAction,
  unlinkEventAction,
  confirmSuggestionAction,
  dismissSuggestionAction,
  updateNeedAction,
  updateProjectAction,
} from "@/app/dashboard/projects/actions";
import { LinkEventForm } from "@/components/event-link-forms";
import { EventStatusBadge } from "@/components/event-status";
import { ActionButton, NeedForm, ProjectForm } from "@/components/project-forms";
import { ProjectStatusBadge } from "@/components/project-status";
import { PROJECT_AUDIENCE_LABELS, type ProjectStatus } from "@/lib/projects";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { getProjectForEditor, listProjectSites } from "@/server/modules/projects";
import { listLinkableEvents, listProjectEventLinks, listSuggestions } from "@/server/modules/eventlinks";
import { listRoster, type RosterRow } from "@/server/modules/volunteers";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Project", robots: { index: false } };
export const dynamic = "force-dynamic";

const EDITABLE: ProjectStatus[] = ["DRAFT", "OPEN", "PAUSED"];
/** Attendance can be recorded once a shift has started (or has no start time). */
const hasStarted = (startsAt: string | null) => startsAt === null || Date.parse(startsAt) <= Date.now();
const ROSTER_STATUS: Record<RosterRow["status"], { label: string; tone: string; icon: string }> = {
  PENDING_EMAIL: { label: "Waiting to confirm", tone: "tone-warn", icon: "⏳" },
  CONFIRMED: { label: "Confirmed", tone: "tone-ok", icon: "✓" },
  CANCELLED: { label: "Cancelled", tone: "tone-muted", icon: "✕" },
  ATTENDED: { label: "Attended", tone: "tone-brand", icon: "●" },
  NO_SHOW: { label: "No-show", tone: "tone-bad", icon: "!" },
};
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
  // The roster holds volunteers' contact details: only org editors, the county's administrators and executives get it.
  const [eventLinks, linkable, suggestions] = await Promise.all([
    listProjectEventLinks(db, user.id, id), listLinkableEvents(db, user.id, id), listSuggestions(db, user.id, { projectId: id }),
  ]);
  let roster: RosterRow[] | null = null;
  try {
    roster = await listRoster(db, user.id, id);
  } catch (err) {
    if (!(err instanceof AppError && err.code === "FORBIDDEN")) throw err;
  }
  const editing = project.canEdit && EDITABLE.includes(project.status);
  const sites = editing ? await listProjectSites(db, user.id, project.orgId) : [];
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
          <ProjectForm action={updateProjectAction.bind(null, project.id)} sites={sites} newSiteHref={`/dashboard/orgs/${project.orgId}/sites/new`} project={project} />
        ) : (
          <dl className="grid gap-1 text-sm">
            <div><dt className="inline font-medium">For:</dt> <dd className="inline">{PROJECT_AUDIENCE_LABELS[project.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? project.audience}</dd></div>
            <div className="mt-1 whitespace-pre-line">{project.description}</div>
            {project.privateLocationNotes && <div className="mt-1"><dt className="inline font-medium">Private location notes:</dt> <dd className="inline">{project.privateLocationNotes}</dd></div>}
          </dl>
        )}
      </section>

      <section className="card mt-5 p-4" aria-labelledby="events-h">
        <h2 id="events-h" className="text-lg font-semibold">Disaster events</h2>
        <p className="mt-1 text-sm text-muted">
          Attaching this project to an event lists it on that event&apos;s public page (once the project is open) so people helping in that area can find it.
          A county administrator can remove a project that does not belong.
        </p>
        {suggestions.length > 0 && (
          <div className="mt-3 rounded-md border border-brand p-3" aria-labelledby="suggested-events-h">
            <h3 id="suggested-events-h" className="font-semibold">Suggested events</h3>
            <p className="text-sm text-muted">This project is inside these events&apos; areas. Add it to show it on the event page.</p>
            <ul className="mt-2 divide-y divide-line">
              {suggestions.map((sg) => (
                <li key={sg.eventId} className="grid gap-2 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
                  <Link className="font-medium text-brand underline" href={`/events/${sg.eventSlug}`}>{sg.eventName}</Link>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton action={confirmSuggestionAction.bind(null, project.id, sg.eventId)} label="Add to event" className="btn btn-primary" />
                    <ActionButton action={dismissSuggestionAction.bind(null, project.id, sg.eventId)} label="Not this one" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="mt-3 divide-y divide-line">
          {eventLinks.map((l) => (
            <li key={l.eventId} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <Link className="font-medium text-brand underline" href={`/events/${l.eventSlug}`}>{l.eventName}</Link>{" "}
                <EventStatusBadge status={l.eventStatus} />
                {l.state === "DISMISSED" && <span className="badge tone-muted"><span aria-hidden="true">✕</span> Removed</span>}
                {l.state === "CONFIRMED" && !l.inArea && (
                  <p className="text-sm text-bad">This project is no longer inside the event&apos;s area, so it is not shown there.</p>
                )}
                {l.state === "DISMISSED" && l.dismissedBy === "ADMIN" && !l.canRelink && (
                  <p className="text-sm text-muted">A county administrator removed this project from the event.</p>
                )}
                {l.state === "DISMISSED" && l.dismissedBy === "ORG" && !l.canRelink && (
                  <p className="text-sm text-muted">Removed by the organization{l.eventStatus === "CLOSED" ? "; the event is closed" : l.inArea ? "" : "; the project is no longer inside the event's area"}.</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {l.canUnlink && <ActionButton action={unlinkEventAction.bind(null, project.id, l.eventId)} label="Remove from this event" />}
                {l.canRelink && <ActionButton action={restoreEventAction.bind(null, project.id, l.eventId)} label="Restore" className="btn btn-primary" />}
              </div>
            </li>
          ))}
          {eventLinks.length === 0 && <li className="py-3 text-sm text-muted">This project is not attached to any event.</li>}
        </ul>
        {linkable.length > 0 && (
          <div className="mt-3"><LinkEventForm action={linkEventAction.bind(null, project.id)} events={linkable} /></div>
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
                  {roster?.some((r) => r.needId === n.id) ? (
                    <p className="mt-2 text-sm text-muted">Volunteers have signed up for this role, so it cannot be removed. Its slots can still be increased.</p>
                  ) : (
                    <div className="mt-2"><ActionButton action={removeNeedAction.bind(null, project.id, n.id)} label="Remove this role" /></div>
                  )}
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

      {roster && (
        <section className="mt-5" aria-labelledby="roster-h">
          <h2 id="roster-h" className="text-lg font-semibold">Volunteers</h2>
          <p className="mt-1 text-sm text-muted">
            These people agreed to share their contact details with {project.orgName} for this project. Treat them as private.
          </p>
          {project.needs.map((n) => {
            const rows = roster.filter((r) => r.needId === n.id);
            const holding = rows.filter((r) => r.status === "PENDING_EMAIL" || r.status === "CONFIRMED" || r.status === "ATTENDED").length;
            return (
              <div key={n.id} className="card mt-3 p-4">
                <h3 className="font-semibold">{n.title} <span className="text-sm font-normal text-muted">· {holding} of {n.slotsNeeded} spots taken</span></h3>
                {(n.startsAt || n.endsAt) && <p className="text-sm text-muted">{fmtShift(n.startsAt)} to {fmtShift(n.endsAt)} (Eastern Time)</p>}
                <ul className="mt-2 divide-y divide-line">
                  {rows.map((r) => {
                    const st = ROSTER_STATUS[r.status];
                    return (
                      <li key={r.id} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div>
                          <p className="font-medium">{r.volunteerName} <span className={`badge ${st.tone}`}><span aria-hidden="true">{st.icon}</span> {st.label}</span></p>
                          <p className="text-sm text-muted">{r.email}{r.phone ? ` · ${r.phone}` : ""}</p>
                        </div>
                        {project.canEdit && (
                          <div className="flex flex-wrap gap-2">
                            {r.status === "CONFIRMED" && hasStarted(n.startsAt) && (
                              <>
                                <ActionButton action={markAttendanceAction.bind(null, project.id, r.id, "ATTENDED")} label="Attended" className="btn btn-primary" />
                                <ActionButton action={markAttendanceAction.bind(null, project.id, r.id, "NO_SHOW")} label="No-show" />
                              </>
                            )}
                            {(r.status === "PENDING_EMAIL" || r.status === "CONFIRMED") && (
                              <ActionButton action={markAttendanceAction.bind(null, project.id, r.id, "CANCELLED")} label="Remove" />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {rows.length === 0 && <li className="py-3 text-sm text-muted">Nobody has signed up yet.</li>}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
