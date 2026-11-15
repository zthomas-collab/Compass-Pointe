import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectForm } from "@/components/project-forms";
import { createProjectAction } from "@/app/dashboard/projects/actions";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listCounties } from "@/server/modules/counties";
import { getOrganizationProfile } from "@/server/modules/directory";
import { listMyOrganizations } from "@/server/modules/organizations";
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
  let served: string[];
  try {
    served = (await getOrganizationProfile(db, user.id, orgId)).countyIds;
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const counties = (await listCounties(db)).filter((c) => served.includes(c.id));
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link href={`/dashboard/orgs/${orgId}/projects`} className="text-sm text-brand underline">← Projects</Link>
      <h1 className="mt-2 text-2xl font-bold">New project</h1>
      <p className="text-sm text-muted">
        You will add the volunteer roles next, then send it for review. Nothing is public until a county administrator approves it.
      </p>
      {counties.length === 0 ? (
        <p className="card mt-4 p-4 text-sm">
          Your organization has not listed any counties as served yet.{" "}
          {org.role === "ORG_ADMIN" ? (
            <Link className="underline" href={`/dashboard/orgs/${orgId}/profile`}>Add them in your organization profile</Link>
          ) : (
            "Ask an organization administrator to add them in the organization profile."
          )}
          .
        </p>
      ) : (
        <div className="card mt-4 p-4">
          <ProjectForm action={createProjectAction.bind(null, orgId)} counties={counties} />
        </div>
      )}
    </div>
  );
}
