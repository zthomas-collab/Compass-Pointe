"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { editResource, moderateResource, submitResource } from "@/server/modules/learning";
import { rateLimit } from "@/server/rate-limit";
import { requireUser } from "@/server/session";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "learning", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}
const entries = (form: FormData) => Object.fromEntries(form.entries());

export async function submitLearningAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const rl = rateLimit(`learn:${user.id}`, 20, 15 * 60_000);
  if (!rl.ok) return { error: "Too many attempts. Please wait and try again." };
  let status: string;
  try {
    ({ status } = await submitResource(await getDriver(), user.id, entries(form)));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/learn");
  redirect(status === "PUBLISHED" ? "/admin/learning?status=PUBLISHED&added=1" : "/dashboard/learning?submitted=1");
}

export async function editLearningAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await editResource(await getDriver(), user.id, entries(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/learn");
  revalidatePath("/dashboard/learning");
  revalidatePath("/admin/learning");
  return { ok: true, message: "Saved. Changes by organizations are reviewed before they appear publicly." };
}

export async function moderateLearningAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await moderateResource(await getDriver(), user.id, entries(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/learn");
  revalidatePath("/admin/learning");
  revalidatePath("/dashboard/learning");
  return { ok: true, message: "Done." };
}
