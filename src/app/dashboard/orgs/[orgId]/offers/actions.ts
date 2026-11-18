"use server";

import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { addOrgOfferNote, transitionOrgOffer } from "@/server/modules/org-offers";
import { requireUser } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "org-offers", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function orgOfferTransitionAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await transitionOrgOffer(await getDriver(), user.id, orgId, Object.fromEntries(form.entries()));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/offers`);
  revalidatePath(`/dashboard/orgs/${orgId}/offers/${text(form, "offerId")}`);
  return { ok: true, message: "Status updated. The giver is emailed when you accept or decline." };
}

export async function orgOfferNoteAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await addOrgOfferNote(await getDriver(), user.id, orgId, text(form, "offerId"), text(form, "note"));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/offers/${text(form, "offerId")}`);
  return { ok: true, message: "Note added." };
}
