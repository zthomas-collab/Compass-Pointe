import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NeedForm, ParticipantForm, ProgressForm, ProposeForm, RespondForm, StatusForm, UpdateForm, VisibilityForm } from "@/components/project-forms";
import { NeedTable, PriorityBadge, ProgressBar, ProjectStatusBadge, typeLabel } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { OFFER_TYPES, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import {
  COMMITMENT_LABELS, PROJECT_STATUS_LABELS, getProject, listApprovableOrgs, suggestMatches, type CommitmentRow, type MatchSuggestion,
} from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import { addNeedAction, addParticipantAction, progressAction, projectStatusAction, proposeAction, respondAction, updateAction, visibilityAction } from "../../../projects/actions";

export const metadata: Metadata = { title: "Project", robots: { index: false } };
export const dynamic = "force-dynamic";
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const n = (v: number) => v.toLocaleString("en-US");

function CommitmentCard({ k, projectId, canManage }: { k: CommitmentRow; projectId: string; canManage: boolean }) {
  const fromOffer = Boolean(k.offerReference);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{k.sourceLabel}</strong>
        <span className="badge tone-brand">{COMMITMENT_LABELS[k.status]}</span>
        <span className="text-muted">{k.needLabel}{k.offerReference ? ` · ${k.offerReference}` : ""}{k.orgName ? ` · ${k.orgName}` : ""}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Offered {n(k.offered)} · accepted {n(k.accepted)} · dispatched {n(k.dispatched)} · received {n(k.received)} · verified {n(k.verified)}
        {k.scheduledFor ? ` · scheduled ${k.scheduledFor}` : ""}{k.receiverName ? ` · confirmed by ${k.receiverName}` : ""}
      </p>
      {k.note && <p className="mt-1 text-xs">Note: {k.note}</p>}
      {canManage && k.status === "PROPOSED" && (
        <div className="mt-2"><RespondForm action={respondAction} projectId={projectId} commitmentId={k.id} offered={k.offered} needsNote={fromOffer || !k.orgName} /></div>
      )}
      {canManage && k.status === "ACCEPTED" && <div className="mt-2"><ProgressForm action={progressAction} projectId={projectId} commitmentId={k.id} stage="DISPATCHED" max={k.accepted} needsReceiver={false} label="Record dispatch" /></div>}
      {canManage && k.status === "DISPATCHED" && <div className="mt-2"><ProgressForm action={progressAction} projectId={projectId} commitmentId={k.id} stage="RECEIVED" max={k.dispatched} needsReceiver label="Record receipt" /></div>}
      {canManage && k.status === "RECEIVED" && <div className="mt-2"><ProgressForm action={progressAction} projectId={projectId} commitmentId={k.id} stage="VERIFIED" max={k.received} needsReceiver label="Verify quantity" /></div>}
    </li>
  );
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDriver();
  let p;
  try {
    p = await getProject(db, user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN" && /Multi-factor/.test(err.message)) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-8"><h1 className="text-2xl">Set up multi-factor authentication first</h1>
          <p className="mt-2">{err.message} <Link className="underline" href="/account/security?required=1">Set it up now</Link>.</p></div>
      );
    }
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  const open = p.status === "DRAFT" || p.status === "ACTIVE" || p.status === "ON_HOLD";
  const orgs = p.canManage ? await listApprovableOrgs(db, user.id) : [];
  const suggestions: Record<string, MatchSuggestion[]> = {};
  if (p.canManage && open) for (const nd of p.needs) suggestions[nd.id] = await suggestMatches(db, user.id, nd.id);
  const categories = OFFER_TYPES.map((t) => ({ value: t, label: OFFER_TYPE_LABELS[t] }));
  const participantOpts = p.participants.map((x) => ({ value: x.orgId, label: x.name }));
  const addable = orgs.filter((o) => !p.participants.some((x) => x.orgId === o.id)).map((o) => ({ value: o.id, label: o.name }));
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/projects">← Projects</Link></p>
      <h1 className="mt-2 text-3xl">{p.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono">{p.reference}</span><ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} />
        <span>{typeLabel(p.category)}</span><span className="text-muted">{p.countyName} County · ZIP {p.zips.join(", ")}</span>
        {p.visibility === "PUBLIC" && <span className="badge tone-ok">Public</span>}
        {p.targetDate && <span className="text-muted">Target {p.targetDate}</span>}
      </div>
      <div className="mt-3 max-w-md"><ProgressBar percent={p.percentVerified} label="Project progress" /></div>
      <p className="mt-3 whitespace-pre-wrap text-sm">{p.description}</p>

      <section className="card mt-5 p-4" aria-labelledby="needs">
        <h2 id="needs" className="text-xl">Resource needs</h2>
        <p className="mt-1 text-xs text-muted">Verified quantities are the only numbers that count toward completion.</p>
        <div className="mt-3">{p.needs.length ? <NeedTable needs={p.needs} /> : <p className="text-sm text-muted">No needs yet.</p>}</div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-5">
          {p.canManage && open && p.needs.map((nd) => (
            <section key={nd.id} className="card p-4" aria-labelledby={`m-${nd.id}`}>
              <h2 id={`m-${nd.id}`} className="text-xl">Suggested matches: {nd.label}</h2>
              <p className="mt-1 text-xs text-muted">Suggestions only. Proposing creates a PROPOSED commitment; nothing is accepted until it is confirmed.</p>
              {suggestions[nd.id].length === 0 ? <p className="mt-2 text-sm text-muted">No open offers fit this need right now.</p> : (
                <ul className="mt-2 divide-y divide-line">
                  {suggestions[nd.id].slice(0, 8).map((s) => (
                    <li key={s.offerId} className="py-2 text-sm">
                      <strong>{s.contributorLabel}</strong> <span className="font-mono text-xs">{s.reference}</span>
                      <div className="text-xs text-muted">{s.reasons.join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 border-t border-line pt-3">
                <ProposeForm action={proposeAction} projectId={p.id} needId={nd.id} unit={nd.unit}
                  offers={suggestions[nd.id].map((s) => ({ value: s.offerId, label: `${s.reference} · ${s.contributorLabel} · ${n(s.available)} available` }))} orgs={participantOpts} />
              </div>
            </section>
          ))}
          <section className="card p-4" aria-labelledby="commitments">
            <h2 id="commitments" className="text-xl">Commitments</h2>
            {p.commitments.length === 0 ? <p className="mt-2 text-sm text-muted">None yet.</p> : (
              <ul className="mt-2 divide-y divide-line">{p.commitments.map((k) => <CommitmentCard key={k.id} k={k} projectId={p.id} canManage={p.canManage} />)}</ul>
            )}
          </section>
          <section className="card p-4" aria-labelledby="updates">
            <h2 id="updates" className="text-xl">Updates</h2>
            {p.updates.length === 0 ? <p className="mt-2 text-sm text-muted">No updates yet.</p> : (
              <ol className="mt-2 grid gap-3">{p.updates.map((u) => (
                <li key={u.id} className="border-l-4 border-gold pl-3 text-sm"><span className="text-xs text-muted">{fmt(u.at)} · {u.isPublic ? "public" : "internal"}</span><p className="whitespace-pre-wrap">{u.body}</p></li>
              ))}</ol>
            )}
          </section>
        </div>
        {p.canManage && (
          <aside className="grid content-start gap-5">
            <section className="card p-4" aria-labelledby="status"><h2 id="status" className="text-xl">Status</h2>
              <p className="mt-1 text-sm">{PROJECT_STATUS_LABELS[p.status]}</p>
              <div className="mt-3"><StatusForm action={projectStatusAction} projectId={p.id} options={p.allowedNext} labels={PROJECT_STATUS_LABELS} /></div></section>
            {open && <section className="card p-4" aria-labelledby="addneed"><h2 id="addneed" className="text-xl">Add a resource need</h2>
              <div className="mt-3"><NeedForm action={addNeedAction} projectId={p.id} categories={categories} /></div></section>}
            <section className="card p-4" aria-labelledby="orgs"><h2 id="orgs" className="text-xl">Participating organizations</h2>
              {p.participants.length === 0 ? <p className="mt-2 text-sm text-muted">None yet.</p> : <ul className="mt-2 list-disc pl-5 text-sm">{p.participants.map((x) => <li key={x.orgId}>{x.name}</li>)}</ul>}
              {open && <div className="mt-3"><ParticipantForm action={addParticipantAction} projectId={p.id} orgs={addable} /></div>}</section>
            <section className="card p-4" aria-labelledby="publish"><h2 id="publish" className="text-xl">Public page</h2>
              <p className="mt-1 text-xs text-muted">Published projects show the summary below, ZIP codes and verified progress. Never contributors, organizations or addresses.</p>
              <div className="mt-3"><VisibilityForm action={visibilityAction} projectId={p.id} current={p.visibility} summary={p.publicSummary} /></div></section>
            <section className="card p-4" aria-labelledby="post"><h2 id="post" className="text-xl">Post an update</h2>
              <div className="mt-3"><UpdateForm action={updateAction} projectId={p.id} /></div></section>
          </aside>
        )}
      </div>
    </div>
  );
}
