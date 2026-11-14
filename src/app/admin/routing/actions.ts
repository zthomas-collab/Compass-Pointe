"use server";

import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { createRoutingRule, setRoutingRuleActive } from "@/server/modules/assistance";
import { requireUser } from "@/server/session";
import type { FormState } from "../../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "routing", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

export async function createRuleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await createRoutingRule(await getDriver(), user.id, Object.fromEntries(form.entries()));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/routing");
  return { ok: true, message: "Rule added." };
}

export async function toggleRuleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await setRoutingRuleActive(await getDriver(), user.id, String(form.get("ruleId") ?? ""), String(form.get("active") ?? "") === "true");
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/routing");
  return { ok: true, message: "Rule updated." };
}
