import Link from "next/link";
import { youTubeEmbedUrl, youTubeWatchUrl } from "@/lib/youtube";
import { LEARNING_CATEGORY_LABELS, LEARNING_STATUS_LABELS, type LearningCategory, type LearningStatus } from "@/server/modules/learning";

export const categoryLabel = (c: LearningCategory) => LEARNING_CATEGORY_LABELS[c];
export const LearningStatusBadge = ({ status }: { status: LearningStatus }) => (
  <span className={`badge ${status === "PUBLISHED" ? "tone-ok" : status === "REJECTED" ? "tone-bad" : status === "PENDING_REVIEW" ? "tone-warn" : "tone-muted"}`}>{LEARNING_STATUS_LABELS[status]}</span>
);

/** Privacy-enhanced YouTube player. The address is rebuilt from a validated 11-character id; a sandboxed frame is the only thing embedded. */
export function VideoEmbed({ youtubeId, title }: { youtubeId: string; title: string }) {
  return (
    <div>
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-line bg-neutral-bg">
        <iframe
          src={youTubeEmbedUrl(youtubeId)}
          title={title}
          className="h-full w-full"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Video plays from YouTube (privacy-enhanced mode). <a className="underline" href={youTubeWatchUrl(youtubeId)} target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
      </p>
    </div>
  );
}

/** Plain-text article: paragraphs split on blank lines and rendered as escaped text. No HTML, Markdown or links are interpreted. */
export function ArticleBody({ body }: { body: string }) {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return <div className="grid gap-4">{paragraphs.map((p, i) => <p key={i} className="whitespace-pre-wrap leading-relaxed">{p}</p>)}</div>;
}

export function LearningCard({ id, title, description, category, kind, orgName, href }: { id: string; title: string; description: string; category: LearningCategory; kind: "VIDEO" | "ARTICLE"; orgName: string | null; href: string }) {
  return (
    <article key={id} className="card p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="badge tone-brand">{kind === "VIDEO" ? "Video" : "Article"}</span><span className="text-muted">{categoryLabel(category)}</span></div>
      <h2 className="mt-1 text-xl"><Link className="underline" href={href}>{title}</Link></h2>
      <p className="mt-1 text-sm">{description}</p>
      {orgName && <p className="mt-1 text-xs text-muted">From {orgName}</p>}
    </article>
  );
}
