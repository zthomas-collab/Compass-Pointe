"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { PROJECT_AUDIENCES, PROJECT_AUDIENCE_LABELS, isoToEasternLocal } from "@/lib/projects";
import type { NeedRow, ProjectRow, ProjectSiteOption } from "@/server/modules/projects";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function ProjectForm({
  action,
  sites,
  newSiteHref,
  project,
}: {
  action: Action;
  /** The organization's locations; the project's county and ZIP come from the one chosen. */
  sites: ProjectSiteOption[];
  newSiteHref: string;
  project?: ProjectRow;
}) {
  const [state, formAction] = useActionState(action, {});
  // A project whose location can no longer be used starts with no location chosen, so the browser never quietly
  // selects another one; the editor is told why and must pick.
  const current = project?.siteId ? sites.find((s) => s.id === project.siteId) : undefined;
  const currentUsable = current?.usable ?? false;
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
      <label className="field sm:col-span-2">
        <span>Location</span>
        {project && !currentUsable && (
          <small className="text-bad" role="status">
            {current ? `This project's location, ${current.name}, can't be used: ${current.reason}.` : "This project has no location yet."}{" "}
            Choose a location below.
          </small>
        )}
        <select className="input" name="siteId" required defaultValue={currentUsable ? project!.siteId! : ""}>
          <option value="" disabled>Choose one of your locations…</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id} disabled={!s.usable}>
              {s.name}{s.city ? ` · ${s.city}` : ""}{s.zip ? ` ${s.zip}` : ""}{s.countyName ? ` (${s.countyName} County)` : ""}
              {s.reason ? ` — ${s.reason}` : ""}
            </option>
          ))}
        </select>
        <small className="text-muted">
          The project shows on the map at this location, and its county and ZIP decide which disaster events it is
          suggested for. <a className="underline" href={newSiteHref}>Add a new location</a>
        </small>
        <FieldError state={state} name="siteId" />
      </label>
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
