"use server";

import { revalidatePath } from "next/cache";
import { actionErrorState } from "@/server/action-state";
import { VOLUNTEER_PATHS, shiftPath } from "@/lib/volunteer-paths";
import { getDriver } from "@/server/db";
import { reviewProject } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

const toState = (err: unknown): FormState => actionErrorState(err, "project-review");

export async function reviewProjectAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await reviewProject(await getDriver(), user.id, id, { decision: form.get("decision"), note: form.get("note") });
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/projects");
  revalidatePath(`/dashboard/projects/${id}`);
  revalidatePath(VOLUNTEER_PATHS.hub);
  revalidatePath(VOLUNTEER_PATHS.shifts);
  revalidatePath(shiftPath(id));
  return { ok: true, message: "Decision recorded." };
}
