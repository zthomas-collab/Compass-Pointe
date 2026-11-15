"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { VOLUNTEER_PATHS } from "@/lib/volunteer-paths";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Public volunteer sign-up for one role. No account; the volunteer confirms from an emailed link. */
export function SignUpForm({ action, orgName }: { action: Action; orgName: string }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) {
    return (
      <div role="status" className="rounded-md bg-ok-bg p-3 text-sm text-ok">
        <p>{state.message}</p>
        <p className="mt-2"><Link className="underline" href={VOLUNTEER_PATHS.shifts}>See other shifts</Link></p>
      </div>
    );
  }
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      {/* Trap field for bots: hidden from people and assistive technology. */}
      <div aria-hidden className="absolute -left-[9999px]">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <Field label="Your name" name="name" state={state} required minLength={2} maxLength={120} autoComplete="name" />
      <Field label="Email" name="email" type="email" state={state} required maxLength={254} autoComplete="email"
        hint="We send one link to confirm your spot." />
      <Field label="Phone (optional)" name="phone" type="tel" state={state} maxLength={40} autoComplete="tel" />
      <label className="sm:col-span-2 inline-flex items-start gap-2 text-sm">
        <input type="checkbox" name="consentShare" value="on" required className="mt-1" />
        <span>I agree to share my name, email and phone with {orgName} so they can coordinate this shift.</span>
      </label>
      <FieldError state={state} name="consentShare" />
      <div className="sm:col-span-2"><SubmitButton>Sign up for this role</SubmitButton></div>
    </form>
  );
}
