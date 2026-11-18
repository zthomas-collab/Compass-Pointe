import ResourceMap from "@/components/ResourceMap";
import { getDriver } from "@/server/db";
import { getPublicSitePin } from "@/server/modules/map";
import { listCategories } from "@/server/modules/sites";
import { getCurrentUser } from "@/server/session";
import { listServiceTypes } from "@/server/modules/directory";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const { site } = await searchParams;
  const db = await getDriver();
  const [user, categories, serviceTypes, initialSite] = await Promise.all([
    getCurrentUser(), listCategories(db), listServiceTypes(db), getPublicSitePin(db, typeof site === "string" ? site : undefined),
  ]);
  return (
    <>
      <ResourceMap categories={categories} signedIn={Boolean(user)} serviceTypes={serviceTypes} initialSite={initialSite} />
    </>
  );
}
