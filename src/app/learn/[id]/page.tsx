import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleBody, VideoEmbed, categoryLabel } from "@/components/learning-ui";
import { getDriver } from "@/server/db";
import { getPublicResource } from "@/server/modules/learning";

export const metadata: Metadata = { title: "Learn" };
export const dynamic = "force-dynamic";

export default async function LearnItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getPublicResource(await getDriver(), id);
  if (!r) notFound();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/learn">← All learning materials</Link></p>
      <h1 className="mt-2 text-3xl">{r.title}</h1>
      <p className="mt-1 text-sm text-muted">{categoryLabel(r.category)}{r.orgName ? ` · From ${r.orgName}` : ""}{r.lastReviewedAt ? ` · Reviewed ${r.lastReviewedAt.toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}</p>
      <p className="mt-3">{r.description}</p>
      <div className="mt-5">{r.kind === "VIDEO" && r.youtubeId ? <VideoEmbed youtubeId={r.youtubeId} title={r.title} /> : r.body ? <ArticleBody body={r.body} /> : null}</div>
      <p className="mt-8 rounded-md bg-bad-bg p-3 text-sm text-bad"><strong>Life-threatening emergency? Call 911.</strong> This is general guidance, not emergency instructions or professional advice.</p>
    </div>
  );
}
