"use server";

import { revalidatePath } from "next/cache";
import { actionErrorState } from "@/server/action-state";
import { redirect } from "next/navigation";
import { getDriver } from "@/server/db";
import { dismissSuggestion, linkProjectToEvent } from "@/server/modules/eventlinks";
import { createEvent, setEventStatus, updateEvent, type EventStatus } from "@/server/modules/events";
import { requireUser } from "@/server/session";
import type { FormState } from "@/app/auth/actions";

const toState = (err: unknown): FormState => actionErrorState(err, "events");

/** Checkboxes post several values under one name; Object.fromEntries would keep only the last. */
const eventFields = (form: FormData) => ({ ...Object.fromEntries(form.entries()), countyIds: form.getAll("countyIds") });

function refresh(slug?: string) {
  revalidatePath("/admin/events");
  revalidatePath("/events");
  if (slug) revalidatePath(`/events/${slug}`);
}

export async function createEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    id = await createEvent(await getDriver(), user.id, eventFields(form));
  } catch (err) {
    return toState(err);
  }
  refresh();
  redirect(`/admin/events/${id}?created=1`);
}

export async function updateEventAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateEvent(await getDriver(), user.id, id, eventFields(form));
  } catch (err) {
    return toState(err);
  }
  refresh(String(form.get("slug") ?? ""));
  return { ok: true, message: "Event saved." };
}

/** Bound as (id, to) and used as a form action; the extra (prev, form) arguments React passes are ignored. */
export async function setEventStatusAction(id: string, to: EventStatus): Promise<FormState> {
  const user = await requireUser();
  try {
    await setEventStatus(await getDriver(), user.id, id, to);
  } catch (err) {
    return toState(err);
  }
  refresh();
  revalidatePath(`/admin/events/${id}`);
  return { ok: true, message: "Status updated." };
}

/** Bound as (eventId, projectId): an administrator accepts a suggested project for this event. */
export async function confirmEventSuggestionAction(eventId: string, projectId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await linkProjectToEvent(await getDriver(), user.id, projectId, eventId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/events/${eventId}`);
  revalidatePath("/events", "layout");
  return { ok: true, message: "Added to the event." };
}

/** Bound as (eventId, projectId): an administrator declines a suggested project for this event. */
export async function dismissEventSuggestionAction(eventId: string, projectId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await dismissSuggestion(await getDriver(), user.id, projectId, eventId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/events/${eventId}`);
  return { ok: true, message: "Suggestion dismissed." };
}
