"use server";

import { getDriver } from "@/server/db";
import { actionErrorState } from "@/server/action-state";
import { signUpForNeed } from "@/server/modules/volunteers";
import { rateLimit } from "@/server/rate-limit";
import { clientKey } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

const SUCCESS: FormState = {
  ok: true,
  message: "Almost done: check your email and open the link to confirm. We are holding your spot for 24 hours.",
};

const toState = (err: unknown): FormState => actionErrorState(err, "volunteer-signup");

/** Public sign-up. No account, so it is guarded by a per-address rate limit and a hidden trap field. */
export async function signUpAction(needId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const rl = rateLimit(`signup:${await clientKey()}`, 6, 15 * 60_000);
  if (!rl.ok) return { error: "Too many attempts. Please wait a few minutes and try again." };
  // Bots fill every field. A person never sees this one; pretend success and store nothing.
  if (String(form.get("website") ?? "")) return SUCCESS;
  try {
    await signUpForNeed(await getDriver(), {
      needId,
      name: form.get("name"),
      email: form.get("email"),
      phone: form.get("phone"),
      consentShare: form.get("consentShare") ?? undefined,
    });
  } catch (err) {
    return toState(err);
  }
  return SUCCESS;
}
