"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Approve (publish) or return a pending project. A note is required either way and is shown to the organization on a return. */
export function ProjectReviewForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <fieldset>
        <legend className="font-medium">Decision</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2"><input type="radio" name="decision" value="APPROVE" required /> Approve and publish</label>
          <label className="inline-flex items-center gap-2"><input type="radio" name="decision" value="RETURN" required /> Return for changes</label>
        </div>
        <FieldError state={state} name="decision" />
      </fieldset>
      <label className="field">
        <span>Note (the organization sees it when you return a project)</span>
        <textarea className="input min-h-20" name="note" required minLength={5} maxLength={2000} />
        <FieldError state={state} name="note" />
      </label>
      <div><SubmitButton>Record decision</SubmitButton></div>
    </form>
  );
}
