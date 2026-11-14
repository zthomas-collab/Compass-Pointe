/**
 * Local demo data so every part of the system has something to look at. Run with the dev server STOPPED (PGlite is
 * single-process):  npm run demo:seed
 *
 * Creates (all clearly labelled DEMO, synthetic, local only):
 *   admin@crisiscompass.test          Executive administrator + county administrator (Buncombe) + admin of the demo pantry
 *   county.admin@crisiscompass.test   County administrator for Buncombe only (to see the county-scoped view)
 *   resident@crisiscompass.test       Resident (to see "Request help" as an applicant)
 * Sign in at /signin with the email; the link appears at /dev/outbox (no real email is sent locally).
 */
import type { Driver, Tx } from "../src/server/db";
import { runIn } from "../src/server/db/context";
import { createRoutingRule, submitApplication, transitionApplication } from "../src/server/modules/assistance";
import { assignCountyAdmin, createCounty } from "../src/server/modules/counties";
import { addEventOrganization, addEventUpdate, addRequirement, addTask, createEvent, linkProject, setEventStatus, setEventVisibility, setTaskStatus } from "../src/server/modules/events";
import { setNotificationEmail, submitOffer, transitionOffer } from "../src/server/modules/offers";
import { grantPlatformRole } from "../src/server/modules/organizations";
import {
  addNeed, addParticipant, addProjectUpdate, createProject, proposeCommitment, reportProgress, respondToCommitment, setProjectStatus, setProjectVisibility,
} from "../src/server/modules/projects";
import { syncZipCounty } from "../src/server/modules/zipcounty";

export const DEMO_ADMIN = "admin@crisiscompass.test";
export const DEMO_COUNTY_ADMIN = "county.admin@crisiscompass.test";
export const DEMO_RESIDENT = "resident@crisiscompass.test";

async function user(tx: Tx, email: string, name: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO users (email, display_name, email_verified_at, is_synthetic) VALUES ($1, $2, now(), true)
     ON CONFLICT (email) DO UPDATE SET email_verified_at = coalesce(users.email_verified_at, now()) RETURNING id`, [email, name]);
  return r[0].id;
}

export async function seedDemo(db: Driver): Promise<string[]> {
  const log: string[] = [];
  const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

  if ((await sys((tx) => tx.query(`SELECT 1 FROM community_projects WHERE title LIKE '[DEMO]%' LIMIT 1`))).length) {
    return ["Demo data already present; nothing changed."];
  }

  // ---- people
  const exec = await grantPlatformRole(db, { email: DEMO_ADMIN, displayName: "Demo Executive Administrator", role: "PLATFORM_ADMIN", reason: "Local demo account" });
  const countyAdmin = await sys((tx) => user(tx, DEMO_COUNTY_ADMIN, "Demo County Administrator"));
  const resident = await sys((tx) => user(tx, DEMO_RESIDENT, "Demo Resident"));

  // ---- counties (static ZIP data gives them FIPS codes, so ZIP/county checks apply)
  const countyId = async (name: string, state: string) => {
    const hit = await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM counties WHERE lower(name) = lower($1) AND state = $2`, [name, state]));
    return hit[0]?.id ?? createCounty(db, exec, { name, state });
  };
  const buncombe = await countyId("Buncombe", "NC");
  const henderson = await countyId("Henderson", "NC");
  await countyId("Aiken", "SC");
  await sys((tx) => tx.query(`DELETE FROM platform_settings WHERE key = 'zip_county_sha256'`));
  await syncZipCounty(db);
  await assignCountyAdmin(db, exec, { email: DEMO_COUNTY_ADMIN, countyId: buncombe, reason: "Local demo county administrator" });
  await assignCountyAdmin(db, exec, { email: DEMO_ADMIN, countyId: buncombe, reason: "Executive also shown the county view" });
  log.push("Counties: Buncombe NC, Henderson NC, Aiken SC");

  // ---- organizations (from the synthetic seed) and the executive as a member of the pantry
  const org = async (like: string) => (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM organizations WHERE display_name LIKE $1 LIMIT 1`, [`%${like}%`])))[0]?.id;
  const pantry = await org("Blue Ridge Community Pantry");
  const water = await org("French Broad Water Relief");
  const casemgmt = await org("Recovery Case Management Partners");
  if (pantry) {
    await sys((tx) => tx.query(
      `INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, 'ORG_ADMIN'::membership_role)
       ON CONFLICT DO NOTHING`, [pantry, exec]));
    await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`, [pantry, buncombe, henderson]).catch(() => undefined));
  }
  if (water) await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [water, buncombe]).catch(() => undefined));
  log.push("Executive account is also an administrator of the demo pantry (so the nonprofit views are visible)");

  // ---- settings
  await setNotificationEmail(db, exec, { email: "offers@crisiscompass.test" });

  // ---- offers
  const offer = (over: Record<string, unknown>) =>
    submitOffer(db, {
      contributorName: "Demo Contributor", email: `demo-${Math.random().toString(36).slice(2, 8)}@example.test`, zip: "28801", contributionType: "DRINKING_WATER",
      quantity: "1000", unit: "cases", description: "[DEMO] Offer created for the local demo.", consentContact: "on", ...over,
    });
  const water1 = await offer({ contributorName: "Mountain Spring Co. (demo)", organizationName: "Mountain Spring Co. (demo)", quantity: "3000", description: "[DEMO] Palletized bottled water, forklift on site." });
  const water2 = await offer({ contributorName: "Pat Giver (demo)", quantity: "1500", zip: "28806", description: "[DEMO] Water cases from a church drive." });
  const food = await offer({ contributorName: "Valley Grocers (demo)", organizationName: "Valley Grocers (demo)", contributionType: "FOOD", quantity: "400", unit: "boxes", zip: "28792", description: "[DEMO] Shelf-stable food boxes." });
  await offer({ contributorName: "Sam Volunteer (demo)", contributionType: "VOLUNTEER_LABOR", quantity: "6", unit: "people", description: "[DEMO] Six volunteers with trucks, weekends." });
  await offer({ contributorName: "Riverbend Storage (demo)", contributionType: "STORAGE_SPACE", quantity: "2", unit: "bays", zip: "29801", description: "[DEMO] Two loading bays available for staging." });
  await offer({ contributorName: "No-County Donor (demo)", zip: "99999", description: "[DEMO] A ZIP outside the loaded data: shows the executive 'assign a county' triage." });
  await transitionOffer(db, exec, { offerId: water1.id, to: "REVIEWED" });
  log.push("Six volunteer/donation offers (one needs a county assigned)");

  // ---- community projects
  const proj = await createProject(db, countyAdmin, {
    title: "[DEMO] Emergency drinking water distribution", description: "Residents in these ZIP codes have no safe drinking water after the storm. We need 5,000 cases staged and delivered.",
    countyId: buncombe, zips: "28801, 28803", category: "DRINKING_WATER", priority: "CRITICAL", startDate: "2026-11-10", targetDate: "2026-12-10",
  });
  const needWater = await addNeed(db, countyAdmin, { projectId: proj.id, label: "Bottled drinking water", contributionType: "DRINKING_WATER", unit: "cases", quantity: 5000 });
  await addNeed(db, countyAdmin, { projectId: proj.id, label: "Volunteer drivers", contributionType: "VOLUNTEER_LABOR", unit: "people", quantity: 12 });
  await setProjectStatus(db, countyAdmin, proj.id, "ACTIVE");
  if (pantry) await addParticipant(db, countyAdmin, proj.id, pantry);
  const k1 = await proposeCommitment(db, countyAdmin, { needId: needWater, offerId: water1.id, quantity: 3000 });
  await respondToCommitment(db, countyAdmin, { commitmentId: k1, accept: "accept", note: "Confirmed by phone with the donor on Monday." });
  await reportProgress(db, countyAdmin, { commitmentId: k1, stage: "DISPATCHED", quantity: 3000 });
  await reportProgress(db, countyAdmin, { commitmentId: k1, stage: "RECEIVED", quantity: 2950, receiverName: "Dana at the fire hall" });
  await reportProgress(db, countyAdmin, { commitmentId: k1, stage: "VERIFIED", quantity: 2900, receiverName: "Dana at the fire hall" });
  await proposeCommitment(db, countyAdmin, { needId: needWater, offerId: water2.id, quantity: 1200, scheduledFor: "2026-11-25" });
  if (pantry) {
    const k3 = await proposeCommitment(db, countyAdmin, { needId: needWater, orgId: pantry, quantity: 500, scheduledFor: "2026-11-27" });
    await respondToCommitment(db, exec, { commitmentId: k3, accept: "accept", note: "Pantry accepted." });
  }
  await addProjectUpdate(db, countyAdmin, proj.id, "First 2,900 cases confirmed delivered to the Riverside fire hall.", true);
  await addProjectUpdate(db, countyAdmin, proj.id, "Internal: loading dock at the fire hall is limited to two trucks at a time.", false);
  await setProjectVisibility(db, countyAdmin, { projectId: proj.id, visibility: "PUBLIC", publicSummary: "Bottled water distribution for ZIP codes 28801 and 28803. Progress shows only quantities confirmed as received." });

  const proj2 = await createProject(db, exec, {
    title: "[DEMO] Shelf-stable food boxes for Henderson County", description: "Food boxes for households displaced by flooding.", countyId: henderson, zips: "28792", category: "FOOD", priority: "HIGH",
  });
  const needFood = await addNeed(db, exec, { projectId: proj2.id, label: "Food boxes", contributionType: "FOOD", unit: "boxes", quantity: 800 });
  await setProjectStatus(db, exec, proj2.id, "ACTIVE");
  await proposeCommitment(db, exec, { needId: needFood, offerId: food.id, quantity: 400 });
  log.push("Two community projects (one public with verified deliveries)");

  // ---- events
  const ev = await createEvent(db, countyAdmin, {
    name: "[DEMO] Hurricane response, Buncombe County", description: "Coordination of water, shelter and debris response after the storm.", category: "HURRICANE",
    countyId: buncombe, zips: "28801, 28803, 28806", startDate: "2026-11-10", endDate: "2026-12-10",
  });
  await setEventStatus(db, countyAdmin, ev.id, "ACTIVE");
  if (pantry) await addEventOrganization(db, countyAdmin, ev.id, pantry);
  if (water) await addEventOrganization(db, countyAdmin, ev.id, water);
  const t1 = await addTask(db, countyAdmin, { eventId: ev.id, title: "Open the water distribution site", priority: "CRITICAL", dueDate: "2026-11-20", assigneeOrgId: water });
  const t2 = await addTask(db, countyAdmin, { eventId: ev.id, title: "Confirm shelter capacity with partners", priority: "HIGH", dueDate: "2026-11-18" });
  const t3 = await addTask(db, countyAdmin, { eventId: ev.id, title: "Schedule volunteer driver shifts", priority: "NORMAL", dueDate: "2026-11-30", assigneeOrgId: pantry });
  await addTask(db, countyAdmin, { eventId: ev.id, title: "Publish a daily status update", priority: "LOW", assigneeEmail: DEMO_COUNTY_ADMIN });
  await setTaskStatus(db, countyAdmin, t1, "IN_PROGRESS");
  await setTaskStatus(db, countyAdmin, t2, "DONE");
  await setTaskStatus(db, countyAdmin, t3, "BLOCKED");
  await addRequirement(db, countyAdmin, { eventId: ev.id, kind: "SUPPLY", label: "Bottled drinking water", quantity: 5000, unit: "cases" });
  await addRequirement(db, countyAdmin, { eventId: ev.id, kind: "EQUIPMENT", label: "Forklifts", quantity: 2, unit: "units" });
  await addRequirement(db, countyAdmin, { eventId: ev.id, kind: "VOLUNTEER", label: "Delivery drivers", quantity: 12, unit: "people" });
  await linkProject(db, countyAdmin, ev.id, proj.id);
  await addEventUpdate(db, countyAdmin, ev.id, "Water distribution site opens Monday at 8 a.m.", true);
  await addEventUpdate(db, countyAdmin, ev.id, "Internal: waiting on county approval for the second staging lot.", false);
  await setEventVisibility(db, countyAdmin, { eventId: ev.id, visibility: "PUBLIC", publicSummary: "Storm recovery coordination for ZIP codes 28801, 28803 and 28806. See community projects for current needs." });
  await createEvent(db, exec, {
    name: "[DEMO] Winter storm readiness, Henderson County", description: "Planning and pre-staging ahead of the forecast winter storm.", category: "WINTER_STORM",
    countyId: henderson, zips: "28792", startDate: "2026-12-15", endDate: "2026-12-20",
  });
  log.push("Two events (one active with tasks, requirements, a linked project and a public page)");

  // ---- assistance applications and a routing rule
  if (casemgmt) await createRoutingRule(db, countyAdmin, { countyId: buncombe, categoryCode: "HOUSING", handlerOrgId: casemgmt, note: "[DEMO] Housing requests go to case management." });
  const form = (over: Record<string, unknown>) => ({
    countyId: buncombe, zip: "28801", categoryCode: "HOUSING", summary: "[DEMO] Roof damage, family of four", situation: "[DEMO] The roof collapsed in the storm and we are staying with relatives.",
    householdSize: "4", contactPhone: "(828) 555-0142", preferredContact: "EMAIL", consentShareProviders: "on", ...over,
  });
  const a1 = await submitApplication(db, resident, form({}));
  const a2 = await submitApplication(db, resident, form({ summary: "[DEMO] No drinking water at home", categoryCode: "FOOD_WATER", situation: "[DEMO] Our well is contaminated after the flooding." }));
  const a3 = await submitApplication(db, resident, form({ summary: "[DEMO] Need debris removal", categoryCode: "CLEANUP_REPAIR", situation: "[DEMO] A tree is blocking the driveway and part of the road." }));
  await transitionApplication(db, countyAdmin, { applicationId: a2, to: "UNDER_REVIEW" });
  await transitionApplication(db, countyAdmin, { applicationId: a2, to: "INFO_REQUIRED", note: "Please tell us whether anyone in the home has a medical need for water.", visibleToApplicant: "on" });
  await transitionApplication(db, countyAdmin, { applicationId: a3, to: "UNDER_REVIEW" });
  await transitionApplication(db, countyAdmin, { applicationId: a3, to: "APPROVED", note: "Approved for referral.", visibleToApplicant: "on" });
  // The housing request is approved and referred to the case-management provider chosen by the routing rule above.
  await transitionApplication(db, countyAdmin, { applicationId: a1, to: "UNDER_REVIEW" });
  await transitionApplication(db, countyAdmin, { applicationId: a1, to: "APPROVED", note: "Approved for referral.", visibleToApplicant: "on" });
  await transitionApplication(db, countyAdmin, { applicationId: a1, to: "REFERRED" });
  log.push("Three assistance applications (referred to a provider, info requested, approved) from the demo resident");

  log.push("", "Sign in at /signin with:", `  ${DEMO_ADMIN}  (executive + county + nonprofit views)`, `  ${DEMO_COUNTY_ADMIN}  (county-scoped view)`, `  ${DEMO_RESIDENT}  (resident view)`, "  relief.editor@example.invalid  (nonprofit provider: referred requests, from the synthetic seed)", "The sign-in link appears at /dev/outbox.");
  return log;
}
