"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Attach a project to one of the events it could belong to (the choices are already filtered to the legal ones). */
export function LinkEventForm({ action, events }: { action: Action; events: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      <label className="field">
        <span>Attach this project to an event</span>
        <select className="input" name="eventId" required defaultValue="">
          <option value="" disabled>Choose an event…</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <FieldError state={state} name="eventId" />
      </label>
      <SubmitButton>Attach to event</SubmitButton>
    </form>
  );
}
