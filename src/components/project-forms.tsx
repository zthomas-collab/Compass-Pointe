"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type County = { id: string; name: string; state: string };
type Opt = { value: string; label: string };

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

export function ProjectForm({ action, counties, categories, priorities }: { action: Action; counties: County[]; categories: Opt[]; priorities: Opt[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Project title" name="title" state={state} required maxLength={140} hint="For example: Emergency drinking water distribution." />
      <label className="field"><span>What is needed and why</span>
        <textarea className="input min-h-28" name="description" required minLength={10} maxLength={4000} />
        <FieldError state={state} name="description" /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field"><span>County</span>
          <select className="input" name="countyId" required defaultValue="">
            <option value="" disabled>Choose a county</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
          </select><FieldError state={state} name="countyId" /></label>
        <Field label="ZIP codes" name="zips" state={state} required hint="Separate with commas: 28801, 28803" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Main resource" name="category" options={categories} />
        <label className="field"><span>Priority</span>
          <select className="input" name="priority" defaultValue="NORMAL">{priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date (optional)" name="startDate" type="date" state={state} />
        <Field label="Target completion (optional)" name="targetDate" type="date" state={state} />
      </div>
      <SubmitButton>Create project</SubmitButton>
    </form>
  );
}

export function NeedForm({ action, projectId, categories }: { action: Action; projectId: string; categories: Opt[] }) {
  return (
    <Mini action={action} submit="Add need">
      <Hidden name="projectId" value={projectId} />
      <label className="field"><span>Resource</span><input className="input" name="label" required maxLength={120} placeholder="Bottled drinking water" /></label>
      <Select label="Type" name="contributionType" options={categories} />
      <div className="grid grid-cols-2 gap-3">
        <label className="field"><span>Quantity</span><input className="input" name="quantity" type="number" min="0" step="any" required /></label>
        <label className="field"><span>Unit</span><input className="input" name="unit" required maxLength={40} placeholder="cases" /></label>
      </div>
    </Mini>
  );
}

export function ParticipantForm({ action, projectId, orgs }: { action: Action; projectId: string; orgs: Opt[] }) {
  if (orgs.length === 0) return <p className="text-sm text-muted">No approved organizations are available to add.</p>;
  return (
    <Mini action={action} submit="Add organization">
      <Hidden name="projectId" value={projectId} />
      <Select label="Approved organization" name="orgId" options={orgs} />
    </Mini>
  );
}

export function ProposeForm({ action, projectId, needId, offers, orgs, unit }: { action: Action; projectId: string; needId: string; offers: Opt[]; orgs: Opt[]; unit: string }) {
  return (
    <Mini action={action} submit="Propose (does not commit)">
      <Hidden name="projectId" value={projectId} />
      <Hidden name="needId" value={needId} />
      <Select label="From an offer" name="offerId" options={offers} required={false} />
      <Select label="and/or a participating organization" name="orgId" options={orgs} required={false} />
      <div className="grid grid-cols-2 gap-3">
        <label className="field"><span>Quantity ({unit})</span><input className="input" name="quantity" type="number" min="0" step="any" required /></label>
        <label className="field"><span>Scheduled for</span><input className="input" name="scheduledFor" type="date" /></label>
      </div>
    </Mini>
  );
}

export function RespondForm({ action, projectId, commitmentId, offered, needsNote }: { action: Action; projectId: string; commitmentId: string; offered: number; needsNote: boolean }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-2">
      <FormMessage state={state} />
      <Hidden name="projectId" value={projectId} />
      <Hidden name="commitmentId" value={commitmentId} />
      <div className="grid grid-cols-2 gap-2">
        <label className="field"><span>Accept quantity</span><input className="input" name="quantity" type="number" min="0" step="any" defaultValue={offered} /></label>
        <label className="field"><span>{needsNote ? "How was it confirmed? (required)" : "Note (optional)"}</span><input className="input" name="note" maxLength={1000} /></label>
      </div>
      <FieldError state={state} name="note" />
      <div className="flex gap-2">
        <button type="submit" name="accept" value="accept" className="btn btn-primary">Accept</button>
        <button type="submit" name="accept" value="decline" className="btn btn-danger">Decline</button>
      </div>
    </form>
  );
}

export function ProgressForm({ action, projectId, commitmentId, stage, max, needsReceiver, label }: { action: Action; projectId: string; commitmentId: string; stage: string; max: number; needsReceiver: boolean; label: string }) {
  return (
    <Mini action={action} submit={label}>
      <Hidden name="projectId" value={projectId} />
      <Hidden name="commitmentId" value={commitmentId} />
      <Hidden name="stage" value={stage} />
      <div className="grid grid-cols-2 gap-2">
        <label className="field"><span>Quantity (up to {max})</span><input className="input" name="quantity" type="number" min="0" max={max} step="any" defaultValue={max} required /></label>
        {needsReceiver && <label className="field"><span>Confirmed by (name)</span><input className="input" name="receiverName" required maxLength={120} /></label>}
      </div>
    </Mini>
  );
}

export function StatusForm({ action, projectId, options, labels }: { action: Action; projectId: string; options: string[]; labels: Record<string, string> }) {
  if (options.length === 0) return <p className="text-sm text-muted">No manual status changes are available. Completion happens automatically when every need is verified.</p>;
  return (
    <Mini action={action} submit="Change status" tone="btn-primary">
      <Hidden name="projectId" value={projectId} />
      <Select label="Move to" name="to" options={options.map((o) => ({ value: o, label: labels[o] ?? o }))} />
    </Mini>
  );
}

export function VisibilityForm({ action, projectId, current, summary }: { action: Action; projectId: string; current: string; summary: string | null }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <Hidden name="projectId" value={projectId} />
      <label className="field"><span>Public summary (no names, addresses or private details)</span>
        <textarea className="input min-h-20" name="publicSummary" maxLength={600} defaultValue={summary ?? ""} />
        <FieldError state={state} name="publicSummary" /></label>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" type="submit" name="visibility" value="PUBLIC">{current === "PUBLIC" ? "Update public summary" : "Publish"}</button>
        {current === "PUBLIC" && <button className="btn btn-secondary" type="submit" name="visibility" value="PRIVATE">Make private</button>}
      </div>
    </form>
  );
}

export function UpdateForm({ action, projectId }: { action: Action; projectId: string }) {
  return (
    <Mini action={action} submit="Post update">
      <Hidden name="projectId" value={projectId} />
      <label className="field"><span>Update</span><textarea className="input min-h-20" name="body" required minLength={2} maxLength={2000} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPublic" className="h-5 w-5" /> Show on the public page (only if the project is public)</label>
    </Mini>
  );
}
