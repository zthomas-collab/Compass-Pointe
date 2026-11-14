import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LearningForm, ModerationForm } from "@/components/learning-forms";
import { ArticleBody, LearningStatusBadge, VideoEmbed, categoryLabel } from "@/components/learning-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { LEARNING_CATEGORIES, LEARNING_CATEGORY_LABELS, LEARNING_STATUSES, LEARNING_STATUS_LABELS, listForModeration } from "@/server/modules/learning";
import { requireUser } from "@/server/session";
import { moderateLearningAction, submitLearningAction } from "../../learn/actions";

export const metadata: Metadata = { title: "Learning moderation", robots: { index: false } };
export const dynamic = "force-dynamic";
const fmt = (d: Date) => d.toLocaleDateString("en-US", { dateStyle: "medium" });

/** Executive-only: review what organizations submitted, publish directly, archive and re-review. */
export default async function LearningAdmin({ searchParams }: { searchParams: Promise<{ status?: string; added?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = sp.status ?? "PENDING_REVIEW";
  let items;
  try {
    items = await listForModeration(await getDriver(), user.id, status);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filter and try again.</p>;
    throw err;
  }
  const tab = (on: boolean) => `rounded-md border px-3 py-1.5 text-sm font-semibold ${on ? "border-brand bg-brand text-white" : "border-line bg-surface"}`;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin">← Administration</Link></p>
      <h1 className="mt-2 text-3xl">Learning library</h1>
      {sp.added && <p role="status" className="mt-3 rounded-md bg-ok-bg p-3 text-sm text-ok">Published. It is now visible at <Link className="underline" href="/learn">/learn</Link>.</p>}
      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Status">
        {LEARNING_STATUSES.map((s) => <Link key={s} className={tab(status === s)} href={`?status=${s}`}>{LEARNING_STATUS_LABELS[s]}</Link>)}
      </nav>
      <section className="mt-4 grid gap-4" aria-label="Items">
        {items.length === 0 ? <p className="text-sm text-muted">Nothing here.</p> : items.map((i) => (
          <article key={i.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm"><LearningStatusBadge status={i.status} /><span className="badge tone-brand">{i.kind === "VIDEO" ? "Video" : "Article"}</span><span className="text-muted">{categoryLabel(i.category)}</span></div>
            <h2 className="mt-1 text-xl">{i.title}</h2>
            <p className="text-xs text-muted">{i.orgName ? `${i.orgName} · ` : ""}{i.submitterEmail} · added {fmt(i.createdAt)}{i.lastReviewedAt ? ` · reviewed ${fmt(i.lastReviewedAt)}` : " · never reviewed"}</p>
            <p className="mt-2 text-sm">{i.description}</p>
            <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold underline">Preview</summary>
              <div className="mt-3">{i.kind === "VIDEO" && i.youtubeId ? <VideoEmbed youtubeId={i.youtubeId} title={i.title} /> : i.body ? <ArticleBody body={i.body} /> : null}</div></details>
            {i.reviewNote && <p className="mt-2 text-sm"><strong>Last note:</strong> {i.reviewNote}</p>}
            <div className="mt-3 border-t border-line pt-3"><ModerationForm action={moderateLearningAction} resourceId={i.id} status={i.status} /></div>
          </article>
        ))}
      </section>
      <section className="card mt-6 p-4" aria-labelledby="add"><h2 id="add" className="text-xl">Add and publish directly</h2>
        <div className="mt-3"><LearningForm action={submitLearningAction} submit="Publish" orgs={[]} categories={LEARNING_CATEGORIES.map((c) => ({ value: c, label: LEARNING_CATEGORY_LABELS[c] }))} /></div></section>
    </div>
  );
}
