"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type Opt = { value: string; label: string };

/** What a resource provider can do with a referral, in plain words. The server enforces the same moves and rules. */
export function ProviderActionForm({ action, applicationId, options }: { action: Action; applicationId: string; options: string[] }) {
  const [state, formAction] = useActionState(action, {});
  const labels: Record<string, { text: string; tone: string }> = {
    IN_PROGRESS: { text: "Accept this referral", tone: "btn btn-primary" },
    COMPLETED: { text: "Mark help completed", tone: "btn btn-primary" },
    APPROVED: { text: "Return to county (cannot help)", tone: "btn btn-danger" },
  };
  const shown = options.filter((o) => labels[o]);
  if (shown.length === 0) return <p className="text-sm text-muted">No actions are available right now.</p>;
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="field">
        <span>Message (required if you return it to the county)</span>
        <textarea className="input min-h-20" name="note" maxLength={2000} />
        <FieldError state={state} name="note" />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="visibleToApplicant" className="h-5 w-5" /> Show this message to the applicant</label>
      <div className="flex flex-wrap gap-2">
        {shown.map((o) => <button key={o} type="submit" name="to" value={o} className={labels[o].tone}>{labels[o].text}</button>)}
      </div>
    </form>
  );
}

export function RuleForm({ action, counties, categories, orgs }: { action: Action; counties: Opt[]; categories: Opt[]; orgs: Opt[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <label className="field"><span>County</span>
        <select className="input" name="countyId" required defaultValue="">
          <option value="" disabled>Choose a county</option>
          {counties.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <FieldError state={state} name="countyId" /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ZIP code (optional)" name="zip" state={state} inputMode="numeric" maxLength={5} hint="Leave blank to cover the whole county." />
        <label className="field"><span>Type of help (optional)</span>
          <select className="input" name="categoryCode" defaultValue="">
            <option value="">Any type</option>
            {categories.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      </div>
      <label className="field"><span>Send suggested referrals to</span>
        <select className="input" name="handlerOrgId" required defaultValue="">
          <option value="" disabled>Choose an approved organization</option>
          {orgs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <FieldError state={state} name="handlerOrgId" /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority (1 = first)" name="priority" type="number" min={1} max={1000} defaultValue={100} state={state} />
        <Field label="Note (optional)" name="note" maxLength={500} state={state} />
      </div>
      <p className="text-xs text-muted">A rule only suggests a provider. A coordinator still approves every referral, and the applicant must have agreed to sharing.</p>
      <div><SubmitButton>Add rule</SubmitButton></div>
    </form>
  );
}

export function RuleToggle({ action, ruleId, active }: { action: Action; ruleId: string; active: boolean }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <SubmitButton className="btn btn-secondary min-h-9 px-3 py-1 text-sm">{active ? "Turn off" : "Turn on"}</SubmitButton>
      {state.error && <span role="alert" className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
