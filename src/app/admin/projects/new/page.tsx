import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectForm } from "@/components/project-forms";
import { getDriver } from "@/server/db";
import { listManageableCounties } from "@/server/modules/counties";
import { OFFER_TYPES, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import { PRIORITIES } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import { createProjectAction } from "../../../projects/actions";

export const metadata: Metadata = { title: "New project", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function NewProject() {
  const user = await requireUser();
  const counties = await listManageableCounties(await getDriver(), user.id).catch(() => []);
  if (counties.length === 0) notFound();
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/projects">← Projects</Link></p>
      <h1 className="mt-2 text-3xl">New community project</h1>
      <p className="mt-2 text-muted">A project connects a specific need in a county and ZIP codes with offered resources. It starts private; you choose what to publish.</p>
      <div className="card mt-5 p-4">
        <ProjectForm action={createProjectAction} counties={counties}
          categories={OFFER_TYPES.map((t) => ({ value: t, label: OFFER_TYPE_LABELS[t] }))}
          priorities={PRIORITIES.map((p) => ({ value: p, label: p.charAt(0) + p.slice(1).toLowerCase() }))} />
      </div>
    </div>
  );
}
