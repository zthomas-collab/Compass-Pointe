import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleForm, RuleToggle } from "@/components/referral-forms";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listAssistanceCategories, listRoutingRules } from "@/server/modules/assistance";
import { listManageableCounties } from "@/server/modules/counties";
import { listApprovableOrgs } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import { createRuleAction, toggleRuleAction } from "./actions";

export const metadata: Metadata = { title: "Routing rules", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function RoutingPage() {
  const user = await requireUser();
  const db = await getDriver();
  const counties = await listManageableCounties(db, user.id).catch(() => []);
  if (counties.length === 0) notFound();
  let rules, orgs;
  try {
    [rules, orgs] = await Promise.all([listRoutingRules(db, user.id), listApprovableOrgs(db, user.id)]);
  } catch (err) {
    if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) notFound();
    throw err;
  }
  const categories = await listAssistanceCategories(db);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin">← Administration</Link></p>
      <h1 className="mt-2 text-3xl">Routing rules</h1>
      <p className="mt-2 text-sm text-muted">
        When a request arrives, the most specific active rule suggests which approved organization should receive it: a matching ZIP code beats a matching type of
        help, which beats a county-wide rule. A rule never sends anything by itself. A coordinator approves each referral, and only if the applicant agreed to sharing.
      </p>
      <section className="card mt-5 p-4" aria-labelledby="rules"><h2 id="rules" className="text-xl">Current rules</h2>
        {rules.length === 0 ? <p className="mt-2 text-sm text-muted">No rules yet. Requests are handled manually by the county administrators.</p> : (
          <ul className="mt-2 divide-y divide-line">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="text-sm">
                  <strong>{r.countyName} County</strong> · {r.zip ? `ZIP ${r.zip}` : "all ZIP codes"} · {r.categoryLabel ?? "any type of help"}
                  <div>→ <strong>{r.handlerOrgName}</strong> <span className="text-muted">(priority {r.priority})</span> {!r.active && <span className="badge tone-muted">Off</span>}</div>
                  {r.note && <div className="text-xs text-muted">{r.note}</div>}
                </div>
                <RuleToggle action={toggleRuleAction} ruleId={r.id} active={r.active} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card mt-5 p-4" aria-labelledby="add"><h2 id="add" className="text-xl">Add a rule</h2>
        <div className="mt-3">
          <RuleForm action={createRuleAction}
            counties={counties.map((c) => ({ value: c.id, label: `${c.name}, ${c.state}` }))}
            categories={categories.map((c) => ({ value: c.code, label: c.label }))}
            orgs={orgs.map((o) => ({ value: o.id, label: o.name }))} />
        </div>
      </section>
    </div>
  );
}
