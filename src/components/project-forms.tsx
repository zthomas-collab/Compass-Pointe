"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { PROJECT_AUDIENCES, PROJECT_AUDIENCE_LABELS, isoToEasternLocal } from "@/lib/projects";
import type { County } from "@/server/modules/counties";
import type { NeedRow, ProjectRow } from "@/server/modules/projects";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function ProjectForm({
  action,
  counties,
  project,
}: {
  action: Action;
  counties: Pick<County, "id" | "name" | "state">[];
  project?: ProjectRow;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      <div className="sm:col-span-2">
        <Field label="Project title" name="title" state={state} required minLength={5} maxLength={140} defaultValue={project?.title}
          placeholder="Muck out flooded homes on Riverside Drive" />
      </div>
      <label className="field sm:col-span-2">
        <span>What is happening and why help is needed</span>
        <textarea className="input min-h-28" name="description" required minLength={10} maxLength={4000} defaultValue={project?.description} />
        <FieldError state={state} name="description" />
      </label>
      <label className="field">
        <span>County</span>
        <select className="input" name="countyId" required defaultValue={project?.countyId ?? ""}>
          <option value="" disabled>Choose a county…</option>
          {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
        </select>
        <small className="text-muted">Only counties your organization profile lists as served.</small>
        <FieldError state={state} name="countyId" />
      </label>
      <Field label="ZIP code" name="zip" state={state} required inputMode="numeric" maxLength={5} defaultValue={project?.zip} placeholder="28801"
        hint="The public sees only the ZIP and county, never the exact address." />
      <label className="field sm:col-span-2">
        <span>Who is this for?</span>
        <select className="input" name="audience" required defaultValue={project?.audience ?? ""}>
          <option value="" disabled>Choose…</option>
          {PROJECT_AUDIENCES.map((a) => <option key={a} value={a}>{PROJECT_AUDIENCE_LABELS[a]}</option>)}
        </select>
        <small className="text-muted">For households, do not put a person&apos;s name or address in the public text.</small>
        <FieldError state={state} name="audience" />
      </label>
      <label className="field sm:col-span-2">
        <span>Exact address or meeting point (private)</span>
        <small className="text-muted">Only shown to confirmed volunteers. Never public.</small>
        <textarea className="input min-h-20" name="privateLocationNotes" maxLength={1000} defaultValue={project?.privateLocationNotes ?? ""} />
        <FieldError state={state} name="privateLocationNotes" />
      </label>
      <div className="sm:col-span-2"><SubmitButton>{project ? "Save project" : "Create draft project"}</SubmitButton></div>
    </form>
  );
}

/** One form for adding a need and for editing one. Shift times are Eastern Time. */
export function NeedForm({ action, need, submitLabel }: { action: Action; need?: NeedRow; submitLabel: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      <Field label="Role" name="title" state={state} required minLength={3} maxLength={120} defaultValue={need?.title} placeholder="Debris removal crew" />
      <Field label="Volunteers needed" name="slotsNeeded" type="number" state={state} required min={1} max={500} defaultValue={need?.slotsNeeded ?? 1} />
      <Field label="Shift starts (Eastern Time)" name="startsAt" type="datetime-local" state={state} defaultValue={isoToEasternLocal(need?.startsAt ?? null)} />
      <Field label="Shift ends (Eastern Time)" name="endsAt" type="datetime-local" state={state} defaultValue={isoToEasternLocal(need?.endsAt ?? null)} />
      <label className="field">
        <span>How urgent?</span>
        <select className="input" name="urgency" defaultValue={need?.urgency ?? "NORMAL"}>
          <option value="NORMAL">Normal</option>
          <option value="URGENT">Urgent</option>
        </select>
      </label>
      <Field label="Skills or what to bring" name="skills" state={state} maxLength={200} defaultValue={need?.skills ?? ""} />
      <label className="field sm:col-span-2">
        <span>What the role involves</span>
        <textarea className="input min-h-20" name="details" maxLength={1000} defaultValue={need?.details ?? ""} />
        <FieldError state={state} name="details" />
      </label>
      <label className="field sm:col-span-2">
        <span>Instructions for confirmed volunteers (private)</span>
        <textarea className="input min-h-16" name="instructions" maxLength={1000} defaultValue={need?.instructions ?? ""} />
        <FieldError state={state} name="instructions" />
      </label>
      <div className="sm:col-span-2"><SubmitButton>{submitLabel}</SubmitButton></div>
    </form>
  );
}

/** A single-button form for one action (submit for review, pause, remove a need). The action ignores form data. */
export function ActionButton({ action, label, className = "btn btn-secondary" }: { action: Action; label: string; className?: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-1">
      <FormMessage state={state} />
      <SubmitButton className={className}>{label}</SubmitButton>
    </form>
  );
}
