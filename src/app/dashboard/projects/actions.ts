"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { easternLocalToIso, type ProjectStatus } from "@/lib/projects";
import { VOLUNTEER_PATHS, shiftPath } from "@/lib/volunteer-paths";
import { addNeed, createProject, removeNeed, setProjectStatus, submitProject, updateNeed, updateProject } from "@/server/modules/projects";
import { linkProjectToEvent, unlinkProjectFromEvent } from "@/server/modules/eventlinks";
import { markAttendance } from "@/server/modules/volunteers";
import { requireUser } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "projects", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

const fields = (form: FormData) => Object.fromEntries(form.entries());

/** Shift times are typed in Eastern Time (datetime-local has no zone); convert before the service sees them. */
const needFields = (form: FormData) => {
  const f = fields(form);
  return { ...f, startsAt: easternLocalToIso(String(f.startsAt ?? "")), endsAt: easternLocalToIso(String(f.endsAt ?? "")) };
};

function refresh(projectId: string) {
  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard");
  revalidatePath("/admin/projects");
  revalidatePath(VOLUNTEER_PATHS.hub);
  revalidatePath(VOLUNTEER_PATHS.shifts);
  revalidatePath(shiftPath(projectId));
}

export async function createProjectAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    id = await createProject(await getDriver(), user.id, orgId, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/projects`);
  redirect(`/dashboard/projects/${id}?created=1`);
}

export async function updateProjectAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateProject(await getDriver(), user.id, id, fields(form));
  } catch (err) {
    return toState(err);
  }
  refresh(id);
  return { ok: true, message: "Project saved." };
}

export async function addNeedAction(projectId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await addNeed(await getDriver(), user.id, projectId, needFields(form));
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Need added." };
}

export async function updateNeedAction(projectId: string, needId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateNeed(await getDriver(), user.id, needId, needFields(form));
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Need saved." };
}

/** Bound as (projectId, needId) and used as a form action; React's extra (prev, form) arguments are ignored. */
export async function removeNeedAction(projectId: string, needId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await removeNeed(await getDriver(), user.id, needId);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Need removed." };
}

export async function submitProjectAction(projectId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await submitProject(await getDriver(), user.id, projectId);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Sent for review." };
}

export async function linkEventAction(projectId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await linkProjectToEvent(await getDriver(), user.id, projectId, String(form.get("eventId") ?? ""));
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  revalidatePath("/events", "layout");
  return { ok: true, message: "Attached to the event." };
}

/** Bound as (projectId, eventId); React's extra (prev, form) arguments are ignored. Also used to restore a dismissed link. */
export async function restoreEventAction(projectId: string, eventId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await linkProjectToEvent(await getDriver(), user.id, projectId, eventId);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  revalidatePath("/events", "layout");
  return { ok: true, message: "Restored." };
}

export async function unlinkEventAction(projectId: string, eventId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await unlinkProjectFromEvent(await getDriver(), user.id, projectId, eventId);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  revalidatePath("/events", "layout");
  return { ok: true, message: "Removed from the event." };
}

/** Bound as (projectId, commitmentId, to); React's extra (prev, form) arguments are ignored. */
export async function markAttendanceAction(projectId: string, commitmentId: string, to: "ATTENDED" | "NO_SHOW" | "CANCELLED"): Promise<FormState> {
  const user = await requireUser();
  try {
    await markAttendance(await getDriver(), user.id, commitmentId, to);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Updated." };
}

export async function setProjectStatusAction(projectId: string, to: ProjectStatus): Promise<FormState> {
  const user = await requireUser();
  try {
    await setProjectStatus(await getDriver(), user.id, projectId, to);
  } catch (err) {
    return toState(err);
  }
  refresh(projectId);
  return { ok: true, message: "Status updated." };
}
