"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import type { County } from "@/server/modules/counties";
import { HAZARD_TYPES } from "@/lib/events";
import type { EventRow, EventStatus } from "@/server/modules/events";
import { HAZARD_LABELS } from "./event-status";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const STATUS_BUTTON: Record<EventStatus, string> = {
  DRAFT: "Back to draft",
  ACTIVE: "Make active (publishes it)",
  RECOVERY: "Move to recovery",
  CLOSED: "Close event (archive, cannot reopen)",
};

/** Shared by "New event" and "Edit event". The slug is read-only once an event has left DRAFT. */
export function EventForm({
  action,
  counties,
  event,
}: {
  action: Action;
  counties: Pick<County, "id" | "name" | "state">[];
  event?: EventRow;
}) {
  const [state, formAction] = useActionState(action, {});
  const chosen = new Set(event?.counties.map((c) => c.id));
  const slugLocked = Boolean(event && event.status !== "DRAFT");
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      <Field label="Event name" name="name" state={state} required minLength={3} maxLength={120} defaultValue={event?.name}
        placeholder="Hurricane X – Carteret County" />
      <Field label="Web address ending" name="slug" state={state} maxLength={80} defaultValue={event?.slug} readOnly={slugLocked}
        hint={slugLocked ? "Fixed once an event is active." : "Optional. Built from the name if left blank."} />
      <label className="field">
        <span>Type of disaster</span>
        <select className="input" name="hazardType" required defaultValue={event?.hazardType ?? ""}>
          <option value="" disabled>Choose…</option>
          {HAZARD_TYPES.map((h) => <option key={h} value={h}>{HAZARD_LABELS[h]}</option>)}
        </select>
        <FieldError state={state} name="hazardType" />
      </label>
      <Field label="Started on" name="startsOn" type="date" state={state} required defaultValue={event?.startsOn} />
      <fieldset className="sm:col-span-2">
        <legend className="font-medium">Counties in the disaster area</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {counties.map((c) => (
            <label key={c.id} className="inline-flex items-center gap-2">
              <input type="checkbox" name="countyIds" value={c.id} defaultChecked={chosen.has(c.id)} />
              {c.name}, {c.state}
            </label>
          ))}
        </div>
        <FieldError state={state} name="countyIds" />
      </fieldset>
      <Field label="ZIP codes (optional)" name="zips" state={state} defaultValue={event?.zips.join(", ")} placeholder="28801, 28804"
        hint="Leave blank to cover whole counties. With ZIPs, only those ZIPs are included." />
      <label className="field sm:col-span-2">
        <span>Summary (shown to the public once active)</span>
        <textarea className="input min-h-24" name="summary" maxLength={2000} defaultValue={event?.summary ?? ""} />
        <FieldError state={state} name="summary" />
      </label>
      <div className="sm:col-span-2"><SubmitButton>{event ? "Save event" : "Create draft event"}</SubmitButton></div>
    </form>
  );
}

export function StatusButton({ action, to }: { action: Action; to: EventStatus }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-1">
      <FormMessage state={state} />
      <SubmitButton className={to === "CLOSED" ? "btn btn-secondary" : "btn btn-primary"}>{STATUS_BUTTON[to]}</SubmitButton>
    </form>
  );
}
