/**
 * Operator CLI. Uses the same driver selection as the app (DATABASE_URL or PGlite dir).
 * PGlite is single-process: STOP the dev server before running these against .data/pglite.
 *
 *   npm run db:migrate
 *   npm run db:seed                       # synthetic demo data (labelled [SYNTHETIC])
 *   npm run admin:grant -- <email> [PLATFORM_ADMIN|SECURITY_ADMIN|ROAD_VERIFIER] "<reason>"
 *   npm run notifications:send [-- --watch]   # deliver queued email (needs EMAIL_TRANSPORT=smtp, SMTP_URL, EMAIL_FROM)
 *   npm run mfa:reset -- <email> "<how identity was verified>"   # lost device and no recovery codes
 */
import { createDriver, type Driver, type Tx } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { runIn } from "../src/server/db/context";
import { grantPlatformRole } from "../src/server/modules/organizations";
import { operatorResetMfa } from "../src/server/modules/mfa";
import { processNotificationJobs, queueStats } from "../src/server/modules/notifications";
import { createTransport } from "../src/server/email";
import { createResource, createSite } from "../src/server/modules/sites";
import { addNeed, createProject, submitProject } from "../src/server/modules/projects";
import { linkProjectToEvent } from "../src/server/modules/eventlinks";
import { uploadSiteImage } from "../src/server/modules/images";
import { getObjectStore } from "../src/server/storage";
import sharp from "sharp";

/** Placeholder photo, visibly labelled synthetic — never a real location photo. */
function syntheticPhoto(title: string, color: string): Promise<Buffer> {
  const esc = (t: string) => t.replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <rect width="800" height="500" fill="${color}"/>
    <rect x="40" y="40" width="720" height="420" fill="none" stroke="#ffffff" stroke-width="6" stroke-dasharray="18 12"/>
    <text x="400" y="210" font-family="Arial, sans-serif" font-size="44" font-weight="bold" fill="#ffffff" text-anchor="middle">SYNTHETIC DEMO PHOTO</text>
    <text x="400" y="280" font-family="Arial, sans-serif" font-size="30" fill="#ffffff" text-anchor="middle">${esc(title)}</text>
    <text x="400" y="340" font-family="Arial, sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">Not a real location</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

async function seed() {
  const db = await createDriver();
  await migrate(db);
  const existing = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM organizations WHERE is_synthetic`),
  );
  if (existing[0].n > 0) {
    console.log("Synthetic data already present; skipping.");
    return db.close();
  }

  const ids = await runIn(db, { kind: "system" }, async (tx) => {
    const user = async (email: string, name: string) =>
      (await tx.query<{ id: string }>(
        `INSERT INTO users (email, display_name, email_verified_at, is_synthetic) VALUES ($1, $2, now(), true) RETURNING id`,
        [email, name],
      ))[0].id;
    const org = async (name: string, type: string, phone: string, service: string, also: string[] = []) => {
      const id = (await tx.query<{ id: string }>(
        `INSERT INTO organizations (legal_name, display_name, org_type, status, contact_email, public_phone, public_email, website,
                                    description, is_synthetic, approved_at, requested_service_type, primary_service_type, directory_consent_at, profile_status)
         VALUES ($1, $1, $2::org_type, 'APPROVED', 'synthetic@example.invalid', $3, $4, 'https://example.org',
                 'Synthetic demo organization. Not a real entity.', true, now(), $5, $5, now(), 'APPROVED')
         RETURNING id`,
        [name, type, phone, `contact+${service.toLowerCase()}@example.invalid`, service],
      ))[0].id;
      await tx.query(`INSERT INTO organization_service_types (org_id, service_type) SELECT $1, unnest($2::text[])`, [id, [service, ...also]]);
      return id;
    };
    const member = (o: string, u: string, role: string) =>
      tx.query(`INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, $3::membership_role)`, [o, u, role]);

    const pantryEditor = await user("pantry.editor@example.invalid", "[SYNTHETIC] Pantry Editor");
    const reliefEditor = await user("relief.editor@example.invalid", "[SYNTHETIC] Relief Editor");
    const responder = await user("responder@example.invalid", "[SYNTHETIC] County Responder");
    const pantry = await org("[SYNTHETIC] Blue Ridge Community Pantry", "NONPROFIT", "(828) 555-0101", "FOOD", ["WATER", "SUPPLIES"]);
    const relief = await org("[SYNTHETIC] Mountain Response Network", "RESPONSE_ORGANIZATION", "(828) 555-0102", "SHELTER", ["SUPPLIES", "TRANSPORTATION"]);
    const clinic = await org("[SYNTHETIC] Valley Mobile Health Clinic", "NONPROFIT", "(828) 555-0103", "HEALTHCARE");
    const casemgmt = await org("[SYNTHETIC] Recovery Case Management Partners", "NONPROFIT", "(828) 555-0104", "DISASTER_CASE_MANAGEMENT", ["FINANCIAL_ASSISTANCE", "HOUSING"]);
    const trees = await org("[SYNTHETIC] Clear Roads Tree Crew", "CONTRACTOR", "(828) 555-0105", "DEBRIS_CLEANUP", ["CONTRACTORS_EQUIPMENT"]);
    const water = await org("[SYNTHETIC] French Broad Water Relief", "NONPROFIT", "(828) 555-0106", "WATER");
    await member(pantry, pantryEditor, "ORG_ADMIN");
    await member(relief, reliefEditor, "EDITOR");
    for (const o of [clinic, casemgmt, trees, water]) await member(o, reliefEditor, "ORG_ADMIN");
    await tx.query(
      `INSERT INTO role_assignments (user_id, role, scope_area, reason)
       VALUES ($1, 'AUTHORIZED_RESPONDER', ST_GeogFromText('MULTIPOLYGON(((-83.2 35.2,-82.0 35.2,-82.0 36.0,-83.2 36.0,-83.2 35.2)))'),
               'Synthetic responder scoped to demo area')`,
      [responder],
    );
    return { pantryEditor, reliefEditor, pantry, relief, clinic, casemgmt, trees, water };
  });

  const sites: [string, string, string, Record<string, unknown>][] = [
    [ids.pantryEditor, ids.pantry, "Downtown Food Distribution", { visibility: "PUBLIC", lat: 35.5951, lng: -82.5515, addressLine: "100 Example St", city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28801", hoursText: "Daily 9am–5pm", publicPhone: "(828) 555-0111" }],
    [ids.reliefEditor, ids.clinic, "Mobile Clinic at Community Center", { visibility: "PUBLIC", lat: 35.6085, lng: -82.5600, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28804", hoursText: "Mon–Sat 9am–4pm", publicPhone: "(828) 555-0133" }],
    [ids.reliefEditor, ids.casemgmt, "Recovery Assistance Desk", { visibility: "PUBLIC", lat: 35.5880, lng: -82.5300, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28801", hoursText: "Weekdays 10am–6pm", publicPhone: "(828) 555-0144" }],
    [ids.reliefEditor, ids.trees, "Tree Crew Dispatch Point", { visibility: "PUBLIC", lat: 35.6300, lng: -82.4500, city: "Weaverville", county: "Buncombe", state: "NC", postalCode: "28787", hoursText: "Daily 7am–7pm" }],
    [ids.reliefEditor, ids.water, "Riverside Water Distribution", { visibility: "PUBLIC", lat: 35.5650, lng: -82.5750, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28806", hoursText: "Daily 8am–6pm" }],
    [ids.pantryEditor, ids.pantry, "West Side Water Point", { visibility: "PUBLIC", lat: 35.5785, lng: -82.6040, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28806", hoursText: "8am–8pm" }],
    [ids.reliefEditor, ids.relief, "Swannanoa Shelter", { visibility: "PUBLIC", lat: 35.5979, lng: -82.3996, city: "Swannanoa", county: "Buncombe", state: "NC", postalCode: "28778", hoursText: "24 hours", publicPhone: "(828) 555-0122" }],
    [ids.reliefEditor, ids.relief, "Equipment Staging Yard (responders only)", { visibility: "AUTHORIZED_RESPONDERS", lat: 35.6170, lng: -82.3200, city: "Black Mountain", county: "Buncombe", state: "NC" }],
    [ids.reliefEditor, ids.relief, "Partner Supply Cache (org network)", { visibility: "ORGANIZATION_NETWORK", lat: 35.4300, lng: -82.5000, city: "Fletcher", county: "Henderson", state: "NC" }],
    [ids.pantryEditor, ids.pantry, "Warehouse (private)", { visibility: "PRIVATE_ORGANIZATION", lat: 35.5200, lng: -82.5300, city: "Asheville", county: "Buncombe", state: "NC" }],
  ];
  const created: Record<string, string> = {};
  for (const [user, org, name, s] of sites) {
    created[name] = await createSite(db, user, org, { name: `[SYNTHETIC] ${name}`, ...s });
  }
  const res = (user: string, site: string, r: Record<string, unknown>) => createResource(db, user, created[site], r);
  await res(ids.pantryEditor, "Downtown Food Distribution", { categoryCode: "FOOD", name: "Hot meals", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "300", quantityUnit: "meals" });
  await res(ids.pantryEditor, "Downtown Food Distribution", { categoryCode: "WATER", name: "Bottled water", visibility: "PUBLIC", availabilityStatus: "LIMITED", reportedQuantity: "40", quantityUnit: "cases" });
  const stale = await res(ids.pantryEditor, "West Side Water Point", { categoryCode: "WATER", name: "Water refill station", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "SHELTER", name: "Overnight cots", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "35", quantityUnit: "beds", quantityBasis: "VERIFIED_COUNT" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "MEDICAL_SUPPORT", name: "First-aid station listing", visibility: "PUBLIC", availabilityStatus: "TEMPORARILY_CLOSED" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "FUEL", name: "Generator fuel reserve", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE", reportedQuantity: "500", quantityUnit: "gallons" });
  await res(ids.reliefEditor, "Equipment Staging Yard (responders only)", { categoryCode: "EQUIPMENT", name: "Chainsaws and skid steer", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Partner Supply Cache (org network)", { categoryCode: "BUILDING_MATERIALS", name: "Tarps and plywood", visibility: "ORGANIZATION_NETWORK", availabilityStatus: "LIMITED" });
  await res(ids.pantryEditor, "Warehouse (private)", { categoryCode: "FOOD", name: "Pallet inventory", visibility: "PRIVATE_ORGANIZATION", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Mobile Clinic at Community Center", { categoryCode: "MEDICAL_SUPPORT", name: "Walk-in first aid & prescriptions help", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Recovery Assistance Desk", { categoryCode: "DISASTER_RECOVERY_SERVICES", name: "FEMA application help (walk-in)", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Recovery Assistance Desk", { categoryCode: "FINANCIAL_ASSISTANCE", name: "Emergency grant referrals", visibility: "PUBLIC", availabilityStatus: "LIMITED" });
  await res(ids.reliefEditor, "Tree Crew Dispatch Point", { categoryCode: "DEBRIS_REMOVAL", name: "Free tree removal for homeowners", visibility: "PUBLIC", availabilityStatus: "LIMITED" });
  await res(ids.reliefEditor, "Riverside Water Distribution", { categoryCode: "WATER", name: "Bottled water pickup", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "800", quantityUnit: "cases" });

  await seedDemoDisaster(db, ids);

  // Synthetic placeholder photos (clearly labelled) so the image feature can be exercised.
  const store = getObjectStore();
  const photo = async (user: string, site: string, color: string) =>
    uploadSiteImage(db, store, user, created[site], { bytes: await syntheticPhoto(site, color), altText: `Synthetic placeholder image for ${site}`, isSynthetic: true });
  await photo(ids.pantryEditor, "Downtown Food Distribution", "#d84315");
  await photo(ids.reliefEditor, "Swannanoa Shelter", "#2e7d32");
  await photo(ids.reliefEditor, "Mobile Clinic at Community Center", "#c62828");
  await photo(ids.reliefEditor, "Recovery Assistance Desk", "#ad1457");
  await photo(ids.reliefEditor, "Equipment Staging Yard (responders only)", "#2e7d32");

  // Demonstrate freshness expiry: back-date one confirmation beyond the water interval.
  await runIn(db, { kind: "system" }, (tx) =>
    tx.query(`UPDATE resource_availability SET last_confirmed_at = now() - interval '20 hours' WHERE resource_id = $1`, [stale]),
  );
  console.log(`Seeded synthetic data: ${sites.length} sites. Synthetic sign-in emails use the example.invalid domain.`);
  await db.close();
}

/**
 * The giver path for a demo: an ACTIVE [SYNTHETIC] hurricane over Buncombe County, organizations that accept in-kind
 * giving (one with an approved "Give money" link), an urgent volunteer project linked to the event, and offers sent to
 * an organization in several states so its Offers tab is not empty. Everything is synthetic and labelled.
 */
async function seedDemoDisaster(db: Driver, ids: { pantryEditor: string; pantry: string; relief: string; clinic: string; casemgmt: string; trees: string; water: string }) {
  const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
  const orgs = [ids.pantry, ids.relief, ids.clinic, ids.casemgmt, ids.trees, ids.water];
  const eventId = await sys(async (tx) => {
    await tx.query(`INSERT INTO counties (name, state, fips) VALUES ('Buncombe', 'NC', '37021') ON CONFLICT (state, name) DO NOTHING`);
    const county = (await tx.query<{ id: string }>(`SELECT id FROM counties WHERE state = 'NC' AND name = 'Buncombe'`))[0].id;
    await tx.query(`INSERT INTO organization_counties (org_id, county_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`, [orgs, county]);
    const ev = (await tx.query<{ id: string }>(
      `INSERT INTO events (name, slug, hazard_type, status, summary, starts_on)
       VALUES ('[SYNTHETIC] Hurricane demo', 'synthetic-hurricane-demo', 'HURRICANE', 'ACTIVE',
               'Synthetic demo disaster. Flooding and wind damage across Buncombe County. Not a real event.', current_date - 3)
       RETURNING id`))[0].id;
    await tx.query(`INSERT INTO event_counties (event_id, county_id) VALUES ($1, $2)`, [ev, county]);
    // What each organization accepts from givers, and one approved money link (set, then approved: changing the
    // link always resets its approval).
    const accept = (org: string, types: string[]) =>
      tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) SELECT $1, unnest($2::text[])`, [org, types]);
    await accept(ids.relief, ["DRINKING_WATER", "FOOD", "CLEANING_SUPPLIES", "BUILDING_SUPPLIES", "TRANSPORTATION"]);
    await accept(ids.pantry, ["FOOD", "DRINKING_WATER"]);
    await accept(ids.water, ["DRINKING_WATER"]);
    await tx.query(`UPDATE organizations SET donation_url = 'https://example.org/donate' WHERE id = $1`, [ids.relief]);
    await tx.query(`UPDATE organizations SET donation_url_status = 'APPROVED', donation_url_reviewed_at = now() WHERE id = $1`, [ids.relief]);
    return ev;
  });

  // An urgent volunteer project at the pantry's public site, approved and linked to the event, so "Who's helping" shows
  // open spots and the map shows it at that site.
  const county = await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM counties WHERE state = 'NC' AND name = 'Buncombe'`)).then((r) => r[0].id);
  const pantrySite = await sys((tx) => tx.query<{ id: string }>(
    `SELECT id FROM staging_sites WHERE org_id = $1 AND name LIKE '%Downtown Food Distribution'`, [ids.pantry])).then((r) => r[0].id);
  const project = await createProject(db, ids.pantryEditor, ids.pantry, {
    title: "[SYNTHETIC] Food box packing after the storm",
    description: "Synthetic demo project. Volunteers pack and hand out food boxes for families affected by the storm.",
    siteId: pantrySite, audience: "COMMUNITY", privateLocationNotes: "Synthetic: loading dock behind the pantry",
  });
  await addNeed(db, ids.pantryEditor, project, { title: "Box packers", slotsNeeded: 12, urgency: "URGENT" });
  await addNeed(db, ids.pantryEditor, project, { title: "Delivery drivers", slotsNeeded: 4 });
  await submitProject(db, ids.pantryEditor, project);
  await sys((tx) => tx.query(`UPDATE projects SET status = 'OPEN', review_note = 'Synthetic demo approval', reviewed_at = now() WHERE id = $1`, [project]));
  await linkProjectToEvent(db, ids.pantryEditor, project, eventId);

  // Offers givers sent to Mountain Response Network, in different states.
  await sys(async (tx) => {
    const offers: [string, string, string, string, string][] = [
      ["[SYNTHETIC] Dana Giver", "dana.giver@example.invalid", "DRINKING_WATER", "Two pallets of bottled water, can deliver Friday.", "MATCHED"],
      ["[SYNTHETIC] Lee Giver", "lee.giver@example.invalid", "CLEANING_SUPPLIES", "Forty mucking kits: buckets, gloves, bleach.", "ACCEPTED"],
      ["[SYNTHETIC] Sam Giver", "sam.giver@example.invalid", "TRANSPORTATION", "Box truck and driver for a day.", "COMPLETED"],
    ];
    for (const [name, email, type, description, status] of offers) {
      const o = (await tx.query<{ id: string }>(
        `INSERT INTO contribution_offers (contributor_name, email, zip, county_id, contribution_type, description, consent_contact, consent_share,
                                          organization_id, status, is_synthetic)
         VALUES ($1, $2, '28801', $3, $4, $5, true, true, $6, $7, true) RETURNING id`,
        [name, email, county, type, description, ids.relief, status],
      ))[0].id;
      await tx.query(
        `INSERT INTO contribution_offer_events (offer_id, actor_role, event_type, to_status, note) VALUES ($1, 'CONTRIBUTOR', 'SUBMITTED', 'MATCHED', 'Offer sent to an organization.')`, [o]);
    }
  });
}

/**
 * Loads ZIP centroids from the U.S. Census Bureau ZCTA Gazetteer file (public domain), e.g.
 * 2024_Gaz_zcta_national.txt — tab-separated with columns GEOID ... INTPTLAT INTPTLONG.
 * Download and unzip it from census.gov yourself, then: npm run zips:import -- <path-to-txt>
 */
async function importZips(file: string | undefined) {
  if (!file) throw new Error("Usage: npm run zips:import -- <path to Census ZCTA gazetteer .txt>");
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split("\t").map((h) => h.trim().toUpperCase());
  const iZip = header.indexOf("GEOID");
  const iLat = header.indexOf("INTPTLAT");
  const iLng = header.indexOf("INTPTLONG");
  if (iZip < 0 || iLat < 0 || iLng < 0) throw new Error("Unrecognized file: expected GEOID, INTPTLAT and INTPTLONG columns");
  const zips: string[] = [];
  const lats: number[] = [];
  const lngs: number[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = line.split("\t").map((v) => v.trim());
    const zip = c[iZip];
    const lat = Number(c[iLat]);
    const lng = Number(c[iLng]);
    if (!/^[0-9]{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      skipped++;
      continue;
    }
    zips.push(zip);
    lats.push(lat);
    lngs.push(lng);
  }
  const db = await createDriver();
  await migrate(db);
  const BATCH = 2000;
  for (let i = 0; i < zips.length; i += BATCH) {
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query(
        `INSERT INTO zip_codes (zip, location, source)
         SELECT z, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, 'census_zcta'
           FROM unnest($1::text[], $2::float8[], $3::float8[]) AS t(z, lat, lng)
         ON CONFLICT (zip) DO UPDATE SET location = EXCLUDED.location, source = EXCLUDED.source, loaded_at = now()`,
        [zips.slice(i, i + BATCH), lats.slice(i, i + BATCH), lngs.slice(i, i + BATCH)],
      ),
    );
  }
  console.log(`Loaded ${zips.length} ZIP centroids (${skipped} rows skipped).`);
  await db.close();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "migrate") {
    const db = await createDriver();
    const ran = await migrate(db);
    console.log(ran.length ? `Applied: ${ran.join(", ")}` : "No pending migrations.");
    await db.close();
  } else if (cmd === "seed") {
    await seed();
  } else if (cmd === "zips") {
    await importZips(args[0]);
  } else if (cmd === "grant") {
    const [email, role = "PLATFORM_ADMIN", reason = "Bootstrap via CLI"] = args;
    if (!email) throw new Error("Usage: npm run admin:grant -- <email> [role] [reason]");
    const db = await createDriver();
    await migrate(db);
    const id = await grantPlatformRole(db, { email, role: role as "PLATFORM_ADMIN", reason });
    console.log(`Granted ${role} to ${email} (user ${id}). Sign in at /signin.`);
    await db.close();
  } else if (cmd === "notifications") {
    const transport = createTransport();
    if (!transport.delivers) {
      console.log("EMAIL_TRANSPORT is not smtp: nothing to deliver (jobs stay queued; see /dev/outbox).");
    } else {
      const db = await createDriver();
      await migrate(db);
      const watch = args.includes("--watch");
      do {
        const r = await processNotificationJobs(db, transport);
        const q = await queueStats(db);
        console.log(JSON.stringify({ at: new Date().toISOString(), ...r, queue: q }));
        if (watch) await new Promise((res) => setTimeout(res, 30_000));
      } while (watch);
      await db.close();
    }
  } else if (cmd === "mfa-reset") {
    const [email, reason] = args;
    if (!email || !reason) throw new Error('Usage: npm run mfa:reset -- <email> "<how identity was verified>"');
    const db = await createDriver();
    await migrate(db);
    await operatorResetMfa(db, email, reason);
    console.log(`MFA removed for ${email}; their sessions were ended. They must enroll again at next sign-in.`);
    await db.close();
  } else {
    console.log("Commands: migrate | seed | grant <email> [role] [reason] | mfa-reset <email> <reason> | notifications [--watch]");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
