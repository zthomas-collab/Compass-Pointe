"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  addEventOrganization, addEventUpdate, addRequirement, addTask, createEvent, linkProject, setEventStatus, setEventVisibility, setTaskStatus, updateEvent,
} from "@/server/modules/events";
import { requireUser } from "@/server/session";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "events", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}
const text = (form: FormData, name: string) => String(form.get(name) ?? "");
const entries = (form: FormData) => Object.fromEntries(form.entries());
const detail = (form: FormData) => `/admin/events/${text(form, "eventId")}`;

async function run(form: FormData, message: string, fn: (userId: string) => Promise<unknown>, paths: string[] = [detail(form)]): Promise<FormState> {
  const user = await requireUser();
  try {
    await fn(user.id);
  } catch (err) {
    return toState(err);
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true, message };
}

export async function createEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    ({ id } = await createEvent(await getDriver(), user.id, entries(form)));
  } catch (err) {
    return toState(err);
  }
  redirect(`/admin/events/${id}`);
}

export const updateEventAction = async (_p: FormState, f: FormData) => run(f, "Event saved.", async (u) => updateEvent(await getDriver(), u, entries(f)));
export const eventStatusAction = async (_p: FormState, f: FormData) => run(f, "Event status updated.", async (u) => setEventStatus(await getDriver(), u, text(f, "eventId"), text(f, "to")));
export const eventVisibilityAction = async (_p: FormState, f: FormData) =>
  run(f, text(f, "visibility") === "PUBLIC" ? "The event summary is now public." : "The event is private again.", async (u) => setEventVisibility(await getDriver(), u, entries(f)));
export const eventOrgAction = async (_p: FormState, f: FormData) => run(f, "Organization added.", async (u) => addEventOrganization(await getDriver(), u, text(f, "eventId"), text(f, "orgId")));
export const addTaskAction = async (_p: FormState, f: FormData) => run(f, "Task added.", async (u) => addTask(await getDriver(), u, entries(f)));
export const taskStatusAction = async (_p: FormState, f: FormData) =>
  run(f, "Task updated.", async (u) => setTaskStatus(await getDriver(), u, text(f, "taskId"), text(f, "to")), [detail(f), "/admin/logistics", "/dashboard/overview"]);
export const requirementAction = async (_p: FormState, f: FormData) => run(f, "Requirement added.", async (u) => addRequirement(await getDriver(), u, entries(f)));
export const eventUpdateAction = async (_p: FormState, f: FormData) => run(f, "Update posted.", async (u) => addEventUpdate(await getDriver(), u, text(f, "eventId"), text(f, "body"), f.get("isPublic") === "on"));
export const linkProjectAction = async (_p: FormState, f: FormData) => run(f, "Project linked to this event.", async (u) => linkProject(await getDriver(), u, text(f, "eventId"), text(f, "projectId")));
