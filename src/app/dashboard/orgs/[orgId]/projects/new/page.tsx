import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectForm } from "@/components/project-forms";
import { createProjectAction } from "@/app/dashboard/projects/actions";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listMyOrganizations } from "@/server/modules/organizations";
import { listProjectSites } from "@/server/modules/projects";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "New project", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function NewProjectPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const db = await getDriver();
  const org = (await listMyOrganizations(db, user.id)).find((o) => o.id === orgId && o.membershipStatus === "ACTIVE");
  const canEdit = org && org.status === "APPROVED" && !org.publicationSuspended && (org.role === "ORG_ADMIN" || org.role === "EDITOR");
  if (!org || !canEdit) notFound();
  let sites: Awaited<ReturnType<typeof listProjectSites>>;
  try {
    sites = await listProjectSites(db, user.id, orgId);
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  const newSiteHref = `/dashboard/orgs/${orgId}/sites/new`;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href={`/dashboard/orgs/${orgId}/projects`} className="text-sm text-brand underline">← Projects</Link>
      <h1 className="mt-2 text-2xl font-bold">New project</h1>
      <p className="text-sm text-muted">
        You will add the volunteer roles next, then send it for review. Nothing is public until a county administrator approves it.
      </p>
      {!sites.some((s) => s.usable) ? (
        <div className="card mt-4 grid gap-2 p-4 text-sm">
          <p>Projects start at one of your locations. Add one first.</p>
          {sites.length > 0 && (
            <p className="text-muted">
              None of your current locations can host a project: its ZIP must be in a county your organization profile lists
              as served.{" "}
              {org.role === "ORG_ADMIN" && <Link className="underline" href={`/dashboard/orgs/${orgId}/profile`}>Check the counties you serve</Link>}
            </p>
          )}
          <p><Link className="btn btn-primary" href={newSiteHref}>Add a new location</Link></p>
        </div>
      ) : (
        <div className="card mt-4 p-4">
          <ProjectForm action={createProjectAction.bind(null, orgId)} sites={sites} newSiteHref={newSiteHref} />
        </div>
      )}
    </div>
  );
}
