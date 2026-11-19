"use server";

import { revalidatePath } from "next/cache";
import { actionErrorState } from "@/server/action-state";
import { getDriver } from "@/server/db";
import { addOrgOfferNote, transitionOrgOffer } from "@/server/modules/org-offers";
import { requireUser } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

const toState = (err: unknown): FormState => actionErrorState(err, "org-offers");

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
