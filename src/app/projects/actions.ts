"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  addNeed, addParticipant, addProjectUpdate, createProject, proposeCommitment, reportProgress, respondToCommitment, setProjectStatus, setProjectVisibility,
} from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "projects", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}
const text = (form: FormData, name: string) => String(form.get(name) ?? "");
const entries = (form: FormData) => Object.fromEntries(form.entries());

async function run(form: FormData, path: string | null, message: string, fn: (userId: string) => Promise<unknown>): Promise<FormState> {
  const user = await requireUser();
  try {
    await fn(user.id);
  } catch (err) {
    return toState(err);
  }
  if (path) revalidatePath(path);
  return { ok: true, message };
}

export async function createProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    ({ id } = await createProject(await getDriver(), user.id, entries(form)));
  } catch (err) {
    return toState(err);
  }
  redirect(`/admin/projects/${id}`);
}

const detail = (form: FormData) => `/admin/projects/${text(form, "projectId")}`;

export const addNeedAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), "Need added.", async (u) => addNeed(await getDriver(), u, entries(form)));

export const addParticipantAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), "Organization added to the project.", async (u) => addParticipant(await getDriver(), u, text(form, "projectId"), text(form, "orgId")));

export const projectStatusAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), "Project status updated.", async (u) => setProjectStatus(await getDriver(), u, text(form, "projectId"), text(form, "to")));

export const visibilityAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), text(form, "visibility") === "PUBLIC" ? "The project summary is now public." : "The project is private again.", async (u) =>
    setProjectVisibility(await getDriver(), u, entries(form)));

export const updateAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), "Update posted.", async (u) => addProjectUpdate(await getDriver(), u, text(form, "projectId"), text(form, "body"), form.get("isPublic") === "on"));

export const proposeAction = async (_p: FormState, form: FormData) =>
  run(form, detail(form), "Proposed. Nothing is committed until it is accepted.", async (u) => proposeCommitment(await getDriver(), u, entries(form)));

export const respondAction = async (_p: FormState, form: FormData) =>
  run(form, null, text(form, "accept") === "accept" ? "Accepted." : "Declined.", async (u) => {
    await respondToCommitment(await getDriver(), u, entries(form));
    revalidatePath(detail(form));
    revalidatePath("/dashboard/commitments");
  });

export const progressAction = async (_p: FormState, form: FormData) =>
  run(form, null, "Progress recorded.", async (u) => {
    await reportProgress(await getDriver(), u, entries(form));
    revalidatePath(detail(form));
    revalidatePath("/dashboard/commitments");
  });
