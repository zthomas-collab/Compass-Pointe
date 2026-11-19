"use server";

import { redirect } from "next/navigation";
import { actionErrorState } from "@/server/action-state";
import QRCode from "qrcode";
import { getDriver } from "@/server/db";
import { resolveSession } from "@/server/modules/identity";
import { beginMfaEnrollment, confirmMfaEnrollment, verifyMfaChallenge } from "@/server/modules/mfa";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, getSessionToken, postSignInPath, requireUser } from "@/server/session";
import type { FormState } from "./actions";

export type MfaSetupState = FormState & { secret?: string; qrSvg?: string; recoveryCodes?: string[] };

const toState = (err: unknown): MfaSetupState => actionErrorState(err, "mfa");

/** Second step of sign-in. The per-account lockout lives in the module; this adds a per-address brake. */
export async function verifyMfaAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await getSessionToken();
  if (!token) redirect("/signin");
  const rl = rateLimit(`mfa:${await clientKey()}`, 20, 15 * 60_000);
  if (!rl.ok) return { error: "Too many attempts. Please wait and try again." };
  try {
    await verifyMfaChallenge(await getDriver(), token, form.get("code"));
  } catch (err) {
    return toState(err);
  }
  const user = await resolveSession(await getDriver(), token);
  redirect(user ? postSignInPath(user) : "/signin");
}

export async function beginMfaEnrollmentAction(): Promise<MfaSetupState> {
  const user = await requireUser();
  try {
    const { secret, uri } = await beginMfaEnrollment(await getDriver(), user.id);
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, width: 192 });
    return { ok: true, secret, qrSvg };
  } catch (err) {
    return toState(err);
  }
}

export async function confirmMfaEnrollmentAction(prev: MfaSetupState, form: FormData): Promise<MfaSetupState> {
  const user = await requireUser();
  const token = await getSessionToken();
  if (!token) redirect("/signin");
  const rl = rateLimit(`mfa-enroll:${user.id}`, 20, 15 * 60_000);
  if (!rl.ok) return { ...prev, error: "Too many attempts. Please wait and try again." };
  try {
    const recoveryCodes = await confirmMfaEnrollment(await getDriver(), user.id, token, form.get("code"));
    return { ok: true, recoveryCodes, message: "Multi-factor authentication is on." };
  } catch (err) {
    return { ...prev, ...toState(err) };
  }
}
