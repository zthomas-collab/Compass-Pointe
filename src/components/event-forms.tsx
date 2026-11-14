"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Opt = { value: string; label: string };
type County = { id: string; name: string; state: string };

function Mini({ action, submit, tone = "btn-secondary", children }: { action: Action; submit: string; tone?: string; children: React.ReactNode }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      {children}
      <div><SubmitButton className={`btn ${tone}`}>{submit}</SubmitButton></div>
    </form>
  );
}
const Hidden = ({ name, value }: { name: string; value: string }) => <input type="hidden" name={name} value={value} />;
const Select = ({ label, name, options, required = true, empty = "Choose one" }: { label: string; name: string; options: Opt[]; required?: boolean; empty?: string }) => (
  <label className="field"><span>{label}</span>
    <select className="input" name={name} required={required} defaultValue="">
      <option value="" disabled={required}>{required ? empty : "None"}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select></label>
);

export function EventForm({ action, counties, categories }: { action: Action; counties: County[]; categories: Opt[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Event name" name="name" state={state} required maxLength={140} />
      <label className="field"><span>Description</span><textarea className="input min-h-24" name="description" required minLength={5} maxLength={4000} /><FieldError state={state} name="description" /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Event type" name="category" options={categories} />
        <label className="field"><span>County</span>
          <select className="input" name="countyId" required defaultValue=""><option value="" disabled>Choose a county</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}</select><FieldError state={state} name="countyId" /></label>
      </div>
      <Field label="ZIP codes" name="zips" state={state} required hint="Separate with commas: 28801, 28803" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" name="startDate" type="date" state={state} required />
        <Field label="End date (optional)" name="endDate" type="date" state={state} />
      </div>
      <p className="rounded-md bg-neutral-bg p-3 text-sm">New events are private. Nothing about staging locations or operations is shown publicly unless you publish a summary.</p>
      <SubmitButton>Create event</SubmitButton>
    </form>
  );
}

export function EditEventForm({ action, eventId, name, description, startDate, endDate, notes }: { action: Action; eventId: string; name: string; description: string; startDate: string; endDate: string | null; notes: string | null }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <Hidden name="eventId" value={eventId} />
      <Field label="Name" name="name" state={state} defaultValue={name} required maxLength={140} />
      <label className="field"><span>Description</span><textarea className="input min-h-20" name="description" defaultValue={description} required maxLength={4000} /></label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start" name="startDate" type="date" state={state} defaultValue={startDate} required />
        <Field label="End" name="endDate" type="date" state={state} defaultValue={endDate ?? ""} />
      </div>
      <label className="field"><span>Internal notes (coordinators only)</span><textarea className="input min-h-20" name="internalNotes" defaultValue={notes ?? ""} maxLength={4000} /></label>
      <div><SubmitButton className="btn btn-primary">Save changes</SubmitButton></div>
    </form>
  );
}

export function EventStatusForm({ action, eventId, options, labels }: { action: Action; eventId: string; options: string[]; labels: Record<string, string> }) {
  if (options.length === 0) return <p className="text-sm text-muted">This event is closed.</p>;
  return (
    <Mini action={action} submit="Change status" tone="btn-primary">
      <Hidden name="eventId" value={eventId} />
      <Select label="Move to" name="to" options={options.map((o) => ({ value: o, label: labels[o] ?? o }))} />
    </Mini>
  );
}

export function EventVisibilityForm({ action, eventId, current, summary }: { action: Action; eventId: string; current: string; summary: string | null }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <Hidden name="eventId" value={eventId} />
      <label className="field"><span>Public summary (no staging locations, names or addresses)</span>
        <textarea className="input min-h-20" name="publicSummary" maxLength={600} defaultValue={summary ?? ""} /><FieldError state={state} name="publicSummary" /></label>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" type="submit" name="visibility" value="PUBLIC">{current === "PUBLIC" ? "Update public summary" : "Publish"}</button>
        {current === "PUBLIC" && <button className="btn btn-secondary" type="submit" name="visibility" value="PRIVATE">Make private</button>}
      </div>
    </form>
  );
}

export function OrgForm({ action, eventId, orgs }: { action: Action; eventId: string; orgs: Opt[] }) {
  if (orgs.length === 0) return <p className="text-sm text-muted">No more approved organizations to add.</p>;
  return (
    <Mini action={action} submit="Add organization"><Hidden name="eventId" value={eventId} /><Select label="Approved organization" name="orgId" options={orgs} /></Mini>
  );
}

export function TaskForm({ action, eventId, orgs }: { action: Action; eventId: string; orgs: Opt[] }) {
  return (
    <Mini action={action} submit="Add task">
      <Hidden name="eventId" value={eventId} />
      <label className="field"><span>Task</span><input className="input" name="title" required minLength={3} maxLength={140} /></label>
      <label className="field"><span>Details (optional)</span><textarea className="input min-h-16" name="description" maxLength={2000} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="field"><span>Priority</span>
          <select className="input" name="priority" defaultValue="NORMAL"><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></label>
        <label className="field"><span>Due</span><input className="input" type="date" name="dueDate" /></label>
      </div>
      <Select label="Assign to a participating organization" name="assigneeOrgId" options={orgs} required={false} />
      <label className="field"><span>Or assign to a person (their account email)</span><input className="input" type="email" name="assigneeEmail" maxLength={254} /></label>
    </Mini>
  );
}

export function TaskMoveForm({ action, taskId, eventId, current }: { action: Action; taskId: string; eventId: string; current: string }) {
  const [state, formAction] = useActionState(action, {});
  const moves = [["TODO", "To do"], ["IN_PROGRESS", "In progress"], ["BLOCKED", "Blocked"], ["DONE", "Done"]].filter(([v]) => v !== current);
  return (
    <form action={formAction} className="mt-2 flex flex-wrap gap-1">
      <Hidden name="taskId" value={taskId} /><Hidden name="eventId" value={eventId} />
      {moves.map(([v, l]) => <button key={v} type="submit" name="to" value={v} className="rounded border border-line bg-white px-2 py-1 text-xs font-semibold hover:bg-neutral-bg">{l}</button>)}
      {state.error && <span role="alert" className="w-full text-xs text-bad">{state.error}</span>}
    </form>
  );
}

export function RequirementForm({ action, eventId }: { action: Action; eventId: string }) {
  return (
    <Mini action={action} submit="Add requirement">
      <Hidden name="eventId" value={eventId} />
      <label className="field"><span>Type</span>
        <select className="input" name="kind" defaultValue="SUPPLY"><option value="SUPPLY">Supply</option><option value="EQUIPMENT">Equipment</option><option value="VOLUNTEER">Volunteers</option></select></label>
      <label className="field"><span>What is needed</span><input className="input" name="label" required minLength={2} maxLength={120} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="field"><span>Quantity</span><input className="input" type="number" name="quantity" min="0" step="any" required /></label>
        <label className="field"><span>Unit</span><input className="input" name="unit" required maxLength={40} placeholder="cases, people…" /></label>
      </div>
    </Mini>
  );
}

export function UpdateForm({ action, eventId }: { action: Action; eventId: string }) {
  return (
    <Mini action={action} submit="Post update">
      <Hidden name="eventId" value={eventId} />
      <label className="field"><span>Status update</span><textarea className="input min-h-20" name="body" required minLength={2} maxLength={2000} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPublic" className="h-5 w-5" /> Show on the public page (only if the event is public)</label>
    </Mini>
  );
}

export function LinkProjectForm({ action, eventId, projects }: { action: Action; eventId: string; projects: Opt[] }) {
  if (projects.length === 0) return <p className="text-sm text-muted">No other projects in this county to link.</p>;
  return (
    <Mini action={action} submit="Link project"><Hidden name="eventId" value={eventId} /><Select label="Project" name="projectId" options={projects} /></Mini>
  );
}
