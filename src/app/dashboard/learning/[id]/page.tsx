import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditLearningForm } from "@/components/learning-forms";
import { LearningStatusBadge } from "@/components/learning-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { LEARNING_CATEGORIES, LEARNING_CATEGORY_LABELS, getMine } from "@/server/modules/learning";
import { youTubeWatchUrl } from "@/lib/youtube";
import { requireUser } from "@/server/session";
import { editLearningAction } from "../../../learn/actions";

export const metadata: Metadata = { title: "Edit learning material", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function EditLearning({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let r;
  try {
    r = await getMine(await getDriver(), user.id, id);
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/dashboard/learning">← Learning materials</Link></p>
      <h1 className="mt-2 text-3xl">{r.title}</h1>
      <p className="mt-1"><LearningStatusBadge status={r.status} /></p>
      {r.status === "REJECTED" && r.reviewNote && <p className="mt-3 rounded-md bg-bad-bg p-3 text-sm text-bad">Reviewer: {r.reviewNote}</p>}
      {r.status === "PUBLISHED" && <p className="mt-3 rounded-md bg-warn-bg p-3 text-sm text-warn">This item is public. Saving changes sends it back for review and hides it until it is approved again.</p>}
      {r.status === "ARCHIVED" ? <p className="mt-4 text-sm text-muted">Archived items cannot be edited.</p> : (
        <div className="card mt-5 p-4">
          <EditLearningForm action={editLearningAction} resourceId={r.id} kind={r.kind} title={r.title} description={r.description} category={r.category}
            categories={LEARNING_CATEGORIES.map((c) => ({ value: c, label: LEARNING_CATEGORY_LABELS[c] }))}
            url={r.youtubeId ? youTubeWatchUrl(r.youtubeId) : ""} body={r.body ?? ""} />
        </div>
      )}
    </div>
  );
}
