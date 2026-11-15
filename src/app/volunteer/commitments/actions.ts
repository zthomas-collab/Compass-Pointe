"use server";

import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { cancelCommitment, confirmCommitment } from "@/server/modules/volunteers";
import type { FormState } from "@/app/auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "volunteer-commitment", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

/** Bound as (token) and used as a form action; React's extra (prev, form) arguments are ignored. Only an explicit press confirms. */
export async function confirmCommitmentAction(token: string): Promise<FormState> {
  try {
    await confirmCommitment(await getDriver(), token);
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/volunteer/commitments");
  return { ok: true, message: "You are confirmed. Thank you!" };
}

export async function cancelCommitmentAction(token: string): Promise<FormState> {
  try {
    await cancelCommitment(await getDriver(), token);
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/volunteer/commitments");
  return { ok: true, message: "Your sign-up was cancelled." };
}
