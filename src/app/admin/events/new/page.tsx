import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventForm } from "@/components/event-forms";
import { getDriver } from "@/server/db";
import { listManageableCounties } from "@/server/modules/counties";
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS } from "@/server/modules/events";
import { requireUser } from "@/server/session";
import { createEventAction } from "../../../events/actions";

export const metadata: Metadata = { title: "New event", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function NewEvent() {
  const user = await requireUser();
  const counties = await listManageableCounties(await getDriver(), user.id).catch(() => []);
  if (counties.length === 0) notFound();
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/events">← Events</Link></p>
      <h1 className="mt-2 text-3xl">New event</h1>
      <div className="card mt-5 p-4">
        <EventForm action={createEventAction} counties={counties} categories={EVENT_CATEGORIES.map((c) => ({ value: c, label: EVENT_CATEGORY_LABELS[c] }))} />
      </div>
    </div>
  );
}
