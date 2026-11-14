import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  EditEventForm, EventStatusForm, EventVisibilityForm, LinkProjectForm, OrgForm, RequirementForm, TaskForm, TaskMoveForm, UpdateForm,
} from "@/components/event-forms";
import { EventStatusBadge, TaskPriorityBadge } from "@/components/event-ui";
import { ProgressBar } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  EVENT_CATEGORY_LABELS, EVENT_STATUS_LABELS, REQUIREMENT_LABELS, TASK_STATUSES, TASK_STATUS_LABELS, getEvent, type TaskRow,
} from "@/server/modules/events";
import { listApprovableOrgs, listProjects } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import {
  addTaskAction, eventOrgAction, eventStatusAction, eventUpdateAction, eventVisibilityAction, linkProjectAction, requirementAction, taskStatusAction, updateEventAction,
} from "../../../events/actions";

export const metadata: Metadata = { title: "Event", robots: { index: false } };
export const dynamic = "force-dynamic";
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function TaskCard({ t, eventId }: { t: TaskRow; eventId: string }) {
  return (
    <li className="rounded-lg border border-line bg-surface p-2 text-sm">
      <div className="font-semibold">{t.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1"><TaskPriorityBadge priority={t.priority} />
        {t.overdue && <span className="badge tone-bad">Overdue</span>}
        {t.dueDate && <span className="text-xs text-muted">due {t.dueDate}</span>}</div>
      {(t.assigneeOrg || t.assigneeUser) && <div className="mt-1 text-xs text-muted">{[t.assigneeOrg, t.assigneeUser].filter(Boolean).join(" · ")}</div>}
      {t.description && <p className="mt-1 text-xs">{t.description}</p>}
      <TaskMoveForm action={taskStatusAction} taskId={t.id} eventId={eventId} current={t.status} />
    </li>
  );
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDriver();
  let e;
  try {
    e = await getEvent(db, user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN" && /Multi-factor/.test(err.message)) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-8"><h1 className="text-2xl">Set up multi-factor authentication first</h1>
          <p className="mt-2">{err.message} <Link className="underline" href="/account/security?required=1">Set it up now</Link>.</p></div>
      );
    }
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  const open = e.status === "SCHEDULED" || e.status === "ACTIVE";
  const orgs = e.canManage ? await listApprovableOrgs(db, user.id) : [];
  const addableOrgs = orgs.filter((o) => !e.participants.some((p) => p.orgId === o.id)).map((o) => ({ value: o.id, label: o.name }));
  const projects = e.canManage ? (await listProjects(db, user.id, { countyId: e.countyId })).filter((p) => !e.projects.some((x) => x.id === p.id)).map((p) => ({ value: p.id, label: `${p.reference} · ${p.title}` })) : [];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/events">← Events</Link></p>
      <h1 className="mt-2 text-3xl">{e.name}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono">{e.reference}</span><EventStatusBadge status={e.status} /><span>{EVENT_CATEGORY_LABELS[e.category]}</span>
        <span className="text-muted">{e.countyName} County · ZIP {e.zips.join(", ")} · {e.startDate}{e.endDate ? ` to ${e.endDate}` : ""}</span>
        {e.leadName && <span>Lead: {e.leadName}</span>}{e.visibility === "PUBLIC" && <span className="badge tone-ok">Public</span>}
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm">{e.description}</p>

      <section className="mt-5 grid gap-3 sm:grid-cols-4" aria-label="Event metrics">
        {[["Tasks", `${e.metrics.tasksDone} / ${e.metrics.tasksTotal} done`], ["Blocked", String(e.metrics.tasksBlocked)], ["Overdue", String(e.metrics.tasksOverdue)], ["Organizations", String(e.participants.length)]].map(([k, v]) => (
          <div key={k} className="card p-3"><div className="text-xs uppercase text-muted">{k}</div><div className="text-xl font-semibold">{v}</div></div>
        ))}
      </section>
      <div className="mt-3 max-w-md"><ProgressBar percent={e.metrics.percentTasksDone} label="Task completion" /></div>

      <section className="mt-5" aria-labelledby="board">
        <h2 id="board" className="text-xl">Task board</h2>
        <div className="mt-2 grid gap-3 md:grid-cols-4">
          {TASK_STATUSES.map((s) => {
            const col = e.tasks.filter((t) => t.status === s);
            return (
              <div key={s} className="rounded-lg bg-neutral-bg p-2">
                <h3 className="text-sm font-semibold">{TASK_STATUS_LABELS[s]} <span className="text-muted">({col.length})</span></h3>
                <ul className="mt-2 grid gap-2">{col.map((t) => <TaskCard key={t.id} t={t} eventId={e.id} />)}</ul>
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="reqs"><h2 id="reqs" className="text-xl">Requirements</h2>
            {e.requirements.length === 0 ? <p className="mt-2 text-sm text-muted">None yet.</p> : (
              <table className="mt-2 w-full text-sm"><thead><tr className="border-b border-line text-left text-xs uppercase text-muted"><th scope="col" className="py-1">Type</th><th scope="col">Item</th><th scope="col" className="text-right">Quantity</th></tr></thead>
                <tbody>{e.requirements.map((r) => <tr key={r.id} className="border-b border-line"><td className="py-1">{REQUIREMENT_LABELS[r.kind]}</td><td>{r.label}</td><td className="text-right">{r.quantity.toLocaleString("en-US")} {r.unit}</td></tr>)}</tbody></table>
            )}</section>
          {e.canManage && (
            <section className="card p-4" aria-labelledby="projects"><h2 id="projects" className="text-xl">Resource projects</h2>
              <p className="mt-1 text-xs text-muted">Commitments and verified deliveries roll up from linked community projects.</p>
              {e.projects.length === 0 ? <p className="mt-2 text-sm text-muted">No projects linked.</p> : (
                <ul className="mt-2 grid gap-3">{e.projects.map((p) => (
                  <li key={p.id}><Link className="font-semibold text-brand underline" href={`/admin/projects/${p.id}`}>{p.title}</Link> <span className="text-xs text-muted">{p.reference} · {p.status.toLowerCase()}</span>
                    <div className="mt-1 max-w-sm"><ProgressBar percent={p.percentVerified} label={`${p.title} verified`} /></div></li>
                ))}</ul>
              )}
              {open && <div className="mt-3 border-t border-line pt-3"><LinkProjectForm action={linkProjectAction} eventId={e.id} projects={projects} /></div>}
            </section>
          )}
          <section className="card p-4" aria-labelledby="orgs"><h2 id="orgs" className="text-xl">Participating organizations</h2>
            {e.participants.length === 0 ? <p className="mt-2 text-sm text-muted">None yet.</p> : <ul className="mt-2 list-disc pl-5 text-sm">{e.participants.map((p) => <li key={p.orgId}>{p.name}</li>)}</ul>}</section>
          <section className="card p-4" aria-labelledby="updates"><h2 id="updates" className="text-xl">Status updates</h2>
            {e.updates.length === 0 ? <p className="mt-2 text-sm text-muted">No updates yet.</p> : (
              <ol className="mt-2 grid gap-3">{e.updates.map((u) => <li key={u.id} className="border-l-4 border-gold pl-3 text-sm"><span className="text-xs text-muted">{fmt(u.at)} · {u.isPublic ? "public" : "internal"}</span><p className="whitespace-pre-wrap">{u.body}</p></li>)}</ol>
            )}</section>
          {e.canManage && e.internalNotes && <section className="card p-4" aria-labelledby="notes"><h2 id="notes" className="text-xl">Internal notes</h2><p className="mt-2 whitespace-pre-wrap text-sm">{e.internalNotes}</p></section>}
        </div>
        {e.canManage && (
          <aside className="grid content-start gap-5">
            <section className="card p-4" aria-labelledby="status"><h2 id="status" className="text-xl">Status</h2><p className="mt-1 text-sm">{EVENT_STATUS_LABELS[e.status]}</p>
              <div className="mt-3"><EventStatusForm action={eventStatusAction} eventId={e.id} options={e.allowedNext} labels={EVENT_STATUS_LABELS} /></div></section>
            {open && <section className="card p-4" aria-labelledby="addtask"><h2 id="addtask" className="text-xl">Add a task</h2>
              <div className="mt-3"><TaskForm action={addTaskAction} eventId={e.id} orgs={e.participants.map((p) => ({ value: p.orgId, label: p.name }))} /></div></section>}
            {open && <section className="card p-4" aria-labelledby="addreq"><h2 id="addreq" className="text-xl">Add a requirement</h2>
              <div className="mt-3"><RequirementForm action={requirementAction} eventId={e.id} /></div></section>}
            {open && <section className="card p-4" aria-labelledby="addorg"><h2 id="addorg" className="text-xl">Add an organization</h2>
              <div className="mt-3"><OrgForm action={eventOrgAction} eventId={e.id} orgs={addableOrgs} /></div></section>}
            <section className="card p-4" aria-labelledby="post"><h2 id="post" className="text-xl">Post an update</h2><div className="mt-3"><UpdateForm action={eventUpdateAction} eventId={e.id} /></div></section>
            <section className="card p-4" aria-labelledby="pub"><h2 id="pub" className="text-xl">Public page</h2>
              <p className="mt-1 text-xs text-muted">Shows only the summary, ZIP codes, dates and status. Never tasks, organizations, notes or staging locations.</p>
              <div className="mt-3"><EventVisibilityForm action={eventVisibilityAction} eventId={e.id} current={e.visibility} summary={e.publicSummary} /></div></section>
            {open && <section className="card p-4" aria-labelledby="edit"><h2 id="edit" className="text-xl">Edit details</h2>
              <div className="mt-3"><EditEventForm action={updateEventAction} eventId={e.id} name={e.name} description={e.description} startDate={e.startDate} endDate={e.endDate} notes={e.internalNotes} /></div></section>}
          </aside>
        )}
      </div>
    </div>
  );
}
