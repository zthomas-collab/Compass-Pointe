"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Opt = { value: string; label: string };

export function LearningForm({ action, categories, orgs, submit }: { action: Action; categories: Opt[]; orgs: Opt[]; submit: string }) {
  const [state, formAction] = useActionState(action, {});
  const [kind, setKind] = useState("VIDEO");
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <label className="field"><span>Type</span>
        <select className="input" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="VIDEO">Video (YouTube link)</option>
          <option value="ARTICLE">Written article</option>
        </select></label>
      <Field label="Title" name="title" state={state} required minLength={5} maxLength={140} />
      <label className="field"><span>Short description (shown in the list)</span>
        <textarea className="input min-h-20" name="description" required minLength={10} maxLength={600} /><FieldError state={state} name="description" /></label>
      <label className="field"><span>Category</span>
        <select className="input" name="category" required defaultValue=""><option value="" disabled>Choose one</option>
          {categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><FieldError state={state} name="category" /></label>
      {orgs.length > 0 && (
        <label className="field"><span>Submitting organization</span>
          <select className="input" name="orgId" defaultValue={orgs.length === 1 ? orgs[0].value : ""}>
            <option value="">{orgs.length === 1 ? "None" : "Choose your organization"}</option>
            {orgs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><FieldError state={state} name="orgId" /></label>
      )}
      {kind === "VIDEO" ? (
        <Field label="YouTube link" name="url" state={state} required type="url" maxLength={300} hint="Paste the address from your browser, for example https://www.youtube.com/watch?v=… or https://youtu.be/… Only YouTube is accepted." />
      ) : (
        <label className="field"><span>Article text</span>
          <small className="text-muted">Plain text only. Leave a blank line between paragraphs. Web addresses and formatting codes are shown as written, not as links.</small>
          <textarea className="input min-h-56" name="body" required minLength={50} maxLength={20000} /><FieldError state={state} name="body" /></label>
      )}
      <p className="rounded-md bg-neutral-bg p-3 text-sm">Do not include personal information about anyone. Items from organizations are reviewed by an administrator before they are published.</p>
      <SubmitButton>{submit}</SubmitButton>
    </form>
  );
}

export function EditLearningForm({ action, resourceId, kind, title, description, category, categories, url, body }: {
  action: Action; resourceId: string; kind: "VIDEO" | "ARTICLE"; title: string; description: string; category: string; categories: Opt[]; url: string; body: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <input type="hidden" name="resourceId" value={resourceId} />
      <Field label="Title" name="title" state={state} defaultValue={title} required minLength={5} maxLength={140} />
      <label className="field"><span>Short description</span><textarea className="input min-h-20" name="description" defaultValue={description} required minLength={10} maxLength={600} /><FieldError state={state} name="description" /></label>
      <label className="field"><span>Category</span>
        <select className="input" name="category" defaultValue={category}>{categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      {kind === "VIDEO" ? (
        <Field label="YouTube link" name="url" state={state} type="url" defaultValue={url} required maxLength={300} />
      ) : (
        <label className="field"><span>Article text (plain text)</span><textarea className="input min-h-56" name="body" defaultValue={body} required minLength={50} maxLength={20000} /><FieldError state={state} name="body" /></label>
      )}
      <SubmitButton>Save changes</SubmitButton>
    </form>
  );
}

export function ModerationForm({ action, resourceId, status }: { action: Action; resourceId: string; status: string }) {
  const [state, formAction] = useActionState(action, {});
  const buttons: [string, string, string][] =
    status === "PENDING_REVIEW" ? [["publish", "Approve and publish", "btn btn-primary"], ["reject", "Do not approve", "btn btn-danger"]]
    : status === "PUBLISHED" ? [["review", "Mark reviewed today", "btn btn-secondary"], ["archive", "Archive", "btn btn-danger"]]
    : status === "ARCHIVED" ? [["publish", "Publish again", "btn btn-primary"]] : [];
  if (buttons.length === 0) return <p className="text-xs text-muted">The submitter can fix and resubmit this item.</p>;
  return (
    <form action={formAction} className="grid gap-2">
      <FormMessage state={state} />
      <input type="hidden" name="resourceId" value={resourceId} />
      <label className="field"><span className="text-xs">Note to the submitter (required if not approving)</span><input className="input" name="note" maxLength={1000} /></label>
      <FieldError state={state} name="note" />
      <div className="flex flex-wrap gap-2">{buttons.map(([v, label, tone]) => <button key={v} type="submit" name="decision" value={v} className={tone}>{label}</button>)}</div>
    </form>
  );
}
