import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectStatusBadge } from "@/components/project-status";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listMyOrganizations } from "@/server/modules/organizations";
import { listOrgProjects } from "@/server/modules/projects";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Projects", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function OrgProjectsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const db = await getDriver();
  const org = (await listMyOrganizations(db, user.id)).find((o) => o.id === orgId && o.membershipStatus === "ACTIVE");
  if (!org) notFound();
  let projects;
  try {
    projects = await listOrgProjects(db, user.id, orgId);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  const canEdit = org.status === "APPROVED" && !org.publicationSuspended && (org.role === "ORG_ADMIN" || org.role === "EDITOR");
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href="/dashboard" className="text-sm text-brand underline">← Dashboard</Link>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{org.displayName}: projects</h1>
        {canEdit && <Link className="btn btn-primary" href={`/dashboard/orgs/${orgId}/projects/new`}>New project</Link>}
      </div>
      <p className="mt-1 text-sm text-muted">
        Projects are local needs that volunteers can help with. A county administrator reviews each one before the public sees it.
      </p>
      <ul className="mt-4 divide-y divide-line">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-3">
            <Link href={`/dashboard/projects/${p.id}`} className="font-medium text-brand underline">{p.title}</Link>
            <ProjectStatusBadge status={p.status} />
            <span className="text-sm text-muted">{p.countyName}, {p.state} · {p.zip}</span>
          </li>
        ))}
        {projects.length === 0 && <li className="py-3 text-sm text-muted">No projects yet.</li>}
      </ul>
    </div>
  );
}
