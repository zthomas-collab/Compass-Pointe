import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { AppError } from "@/server/errors";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  createEvent, getEventAdmin, getEventHelp, getPublicEvent, listEventsAdmin, listPublicEvents, setEventStatus, slugify, updateEvent,
} from "@/server/modules/events";
import { createResource, createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

let db: Driver;
let exec: string;
let plain: string;
let countyAdmin: string;
let buncombe: string;
let henderson: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const count = async () => (await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM events`)))[0].n;

const base = (over: Record<string, unknown> = {}) => ({
  name: "Hurricane X – Carteret",
  hazardType: "HURRICANE",
  startsOn: "2026-09-10",
  countyIds: [buncombe],
  ...over,
});

beforeAll(async () => {
  db = await freshDb();
  exec = await makeUser(db, "exec@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  plain = await makeUser(db, "plain@example.test");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  await assignCountyAdmin(db, exec, { email: "county-admin@example.test", countyId: buncombe, reason: "County coordinator" });
  countyAdmin = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM users WHERE email = 'county-admin@example.test'`)))[0].id;
});
afterAll(async () => db?.close());

describe("event creation", () => {
  it("lets only a platform admin create an event", async () => {
    const id = await createEvent(db, exec, base());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    for (const who of [plain, countyAdmin]) {
      await expect(createEvent(db, who, base({ name: "Nope Event" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("creates a DRAFT event with counties and ZIPs and audits it", async () => {
    const id = await createEvent(db, exec, base({ name: "Flood Y", countyIds: [buncombe, henderson], zips: ["28801"] }));
    const ev = await getEventAdmin(db, exec, id);
    expect(ev).toMatchObject({ status: "DRAFT", hazardType: "HURRICANE", zips: ["28801"], closedOn: null });
    expect(ev!.counties.map((c) => c.name).sort()).toEqual(["Buncombe", "Henderson"]);
    const audit = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'EVENT_CREATED' AND subject_id = $1`, [id]));
    expect(audit).toHaveLength(1);
    expect((await listEventsAdmin(db, exec)).map((e) => e.id)).toContain(id);
  });

  it("derives a slug from the name and rejects duplicates", async () => {
    expect(slugify("Hurricane X – Carteret")).toBe("hurricane-x-carteret");
    const ev = await getEventAdmin(db, exec, (await listEventsAdmin(db, exec)).find((e) => e.name === "Hurricane X – Carteret")!.id);
    expect(ev!.slug).toBe("hurricane-x-carteret");
    await expect(createEvent(db, exec, base())).rejects.toBeInstanceOf(AppError);
  });

  it("rejects zero counties, duplicate counties, and unknown ZIPs", async () => {
    const before = await count();
    await expect(createEvent(db, exec, base({ name: "Zero Counties", countyIds: [] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createEvent(db, exec, base({ name: "Bad Zip", zips: ["00000"] }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await count()).toBe(before);
    const id = await createEvent(db, exec, base({ name: "Dup Counties", countyIds: [buncombe, buncombe] }));
    expect((await getEventAdmin(db, exec, id))!.counties).toHaveLength(1);
  });

  it("rejects an empty slug and the reserved slug 'new'", async () => {
    await expect(createEvent(db, exec, base({ name: "!!!" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createEvent(db, exec, base({ name: "Reserved Slug Event", slug: "new" }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("hides DRAFT events from anon at the database", async () => {
    const id = await createEvent(db, exec, base({ name: "Secret Draft" }));
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM events`))).rejects.toMatchObject({ code: "42501" });
    const rows = await runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM public_events WHERE id = $1`, [id]));
    expect(rows).toHaveLength(0);
  });
});

describe("event status and edits", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("walks DRAFT to ACTIVE to RECOVERY to CLOSED and audits each step", async () => {
    const id = await createEvent(db, exec, base({ name: "Walk Through Event" }));
    for (const to of ["ACTIVE", "RECOVERY", "CLOSED"] as const) await setEventStatus(db, exec, id, to);
    expect((await getEventAdmin(db, exec, id))!.status).toBe("CLOSED");
    const audit = await sys((tx) =>
      tx.query<{ details: { from: string; to: string } }>(
        `SELECT details FROM audit_logs WHERE action = 'EVENT_STATUS_CHANGED' AND subject_id = $1 ORDER BY occurred_at, id`, [id]),
    );
    expect(audit.map((a) => `${a.details.from}>${a.details.to}`).sort()).toEqual(["ACTIVE>RECOVERY", "DRAFT>ACTIVE", "RECOVERY>CLOSED"]);
  });

  it("sets closed_on exactly when closing and never reopens", async () => {
    const id = await createEvent(db, exec, base({ name: "Close And Stay Closed" }));
    await setEventStatus(db, exec, id, "ACTIVE");
    expect((await getEventAdmin(db, exec, id))!.closedOn).toBeNull();
    await setEventStatus(db, exec, id, "CLOSED");
    expect((await getEventAdmin(db, exec, id))!.closedOn).toBe(today());
    await expect(setEventStatus(db, exec, id, "ACTIVE")).rejects.toMatchObject({ code: "VALIDATION" });
    const ev = (await getEventAdmin(db, exec, id))!;
    expect(ev.status).toBe("CLOSED");
    expect(ev.closedOn).toBe(today());
  });

  it("treats a closed event as a read-only archive", async () => {
    const id = await createEvent(db, exec, base({ name: "Archived Read Only" }));
    await setEventStatus(db, exec, id, "ACTIVE");
    await setEventStatus(db, exec, id, "CLOSED");
    const before = (await getEventAdmin(db, exec, id))!;
    await expect(updateEvent(db, exec, id, base({ name: "Archived Renamed", slug: before.slug }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateEvent(db, exec, id, base({ name: "Archived Read Only", slug: before.slug, startsOn: "2027-01-01" }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getEventAdmin(db, exec, id)).toEqual(before);
  });

  it("rejects illegal jumps", async () => {
    const id = await createEvent(db, exec, base({ name: "Illegal Jumps Event" }));
    await expect(setEventStatus(db, exec, id, "CLOSED")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setEventStatus(db, exec, id, "RECOVERY")).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await getEventAdmin(db, exec, id))!.status).toBe("DRAFT");
  });

  it("updates fields and areas, audits, and locks the slug after activation", async () => {
    const id = await createEvent(db, exec, base({ name: "Editable Event" }));
    await updateEvent(db, exec, id, base({ name: "Editable Event Renamed", slug: "editable-renamed", countyIds: [henderson], zips: ["28801"] }));
    let ev = (await getEventAdmin(db, exec, id))!;
    expect(ev).toMatchObject({ name: "Editable Event Renamed", slug: "editable-renamed", zips: ["28801"] });
    expect(ev.counties.map((c) => c.name)).toEqual(["Henderson"]);
    await setEventStatus(db, exec, id, "ACTIVE");
    await expect(updateEvent(db, exec, id, base({ name: "Editable Event Renamed", slug: "other-slug" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await updateEvent(db, exec, id, base({ name: "Editable Event Renamed", slug: "editable-renamed", summary: "Updated summary" }));
    ev = (await getEventAdmin(db, exec, id))!;
    expect(ev.summary).toBe("Updated summary");
    expect(ev.slug).toBe("editable-renamed");
    const audit = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'EVENT_UPDATED' AND subject_id = $1`, [id]));
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const who of [plain, countyAdmin]) {
      await expect(updateEvent(db, who, id, base())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(setEventStatus(db, who, id, "RECOVERY")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

describe("public events", () => {
  it("lists public events with active ones first and never drafts", async () => {
    const mk = async (name: string, startsOn: string, to: ("ACTIVE" | "RECOVERY" | "CLOSED")[]) => {
      const id = await createEvent(db, exec, base({ name, startsOn }));
      for (const s of to) await setEventStatus(db, exec, id, s);
      return id;
    };
    await mk("Pub Closed Old", "2026-01-05", ["ACTIVE", "CLOSED"]);
    await mk("Pub Active Newer", "2026-10-01", ["ACTIVE"]);
    await mk("Pub Recovery Older", "2026-09-01", ["ACTIVE", "RECOVERY"]);
    await createEvent(db, exec, base({ name: "Pub Hidden Draft" }));
    const names = (await listPublicEvents(db)).map((e) => e.name).filter((n) => n.startsWith("Pub "));
    expect(names).toEqual(["Pub Active Newer", "Pub Recovery Older", "Pub Closed Old"]);
  });

  it("returns null from getPublicEvent for a draft and for an unknown slug", async () => {
    expect(await getPublicEvent(db, "pub-hidden-draft")).toBeNull();
    expect(await getPublicEvent(db, "no-such-event")).toBeNull();
    expect(await getPublicEvent(db, "PUB-ACTIVE-NEWER")).toBeNull();
    expect(await getPublicEvent(db, "pub-active-newer")).toMatchObject({ name: "Pub Active Newer", status: "ACTIVE" });
  });

  it("keeps a closed event public", async () => {
    expect(await getPublicEvent(db, "pub-closed-old")).toMatchObject({ status: "CLOSED", closedOn: expect.any(String) });
  });
});

describe("event help list", () => {
  let editor: string;
  let activeEvent: string;
  let zipEvent: string;
  let draftEvent: string;
  const helpNames = async (id: string) => (await getEventHelp(db, id)).map((h) => h.siteName).sort();

  beforeAll(async () => {
    editor = await makeUser(db, "help-editor@example.test");
    const org = await makeOrg(db, { name: "Help Org", members: [{ userId: editor, role: "EDITOR" }] });
    const add = (name: string, over: Record<string, unknown>) => createSite(db, editor, org, site({ name: `[TEST] ${name}`, ...over }));
    const water = await add("Help A", { county: "Buncombe", postalCode: "28801" });
    await add("Help B", { county: "buncombe county", postalCode: "28804" });
    await add("Help C", { county: "Buncombe County", postalCode: "28806" });
    await add("Help Wrong State", { county: "Buncombe", state: "SC", postalCode: "29601" });
    await add("Help Other County", { county: "Madison", postalCode: "28753" });
    await add("Help Private", { county: "Buncombe", postalCode: "28801", visibility: "PRIVATE_ORGANIZATION" });
    const susp = await makeOrg(db, { name: "Suspended Help Org", members: [{ userId: editor, role: "EDITOR" }] });
    await createSite(db, editor, susp, site({ name: "[TEST] Help Suspended", county: "Buncombe", postalCode: "28801" }));
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [susp]));
    await createResource(db, editor, water, { categoryCode: "WATER", name: "Bottled water", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });

    activeEvent = await createEvent(db, exec, base({ name: "Help Area Event", countyIds: [buncombe] }));
    await setEventStatus(db, exec, activeEvent, "ACTIVE");
    zipEvent = await createEvent(db, exec, base({ name: "Help Zip Event", countyIds: [buncombe], zips: ["28801"] }));
    await setEventStatus(db, exec, zipEvent, "ACTIVE");
    draftEvent = await createEvent(db, exec, base({ name: "Help Draft Event", countyIds: [buncombe] }));
  });

  it("matches help sites by county, tolerating a 'County' suffix and casing", async () => {
    expect(await helpNames(activeEvent)).toEqual(["[TEST] Help A", "[TEST] Help B", "[TEST] Help C"]);
  });

  it("narrows help to the event's ZIPs when ZIPs are set", async () => {
    expect(await helpNames(zipEvent)).toEqual(["[TEST] Help A"]);
  });

  it("excludes private sites and sites of suspended organizations", async () => {
    const names = await helpNames(activeEvent);
    expect(names).not.toContain("[TEST] Help Private");
    expect(names).not.toContain("[TEST] Help Suspended");
  });

  it("returns nothing for a draft event", async () => {
    expect(await getEventHelp(db, draftEvent)).toEqual([]);
  });

  it("returns each site's resources with status and freshness", async () => {
    const a = (await getEventHelp(db, activeEvent)).find((h) => h.siteName === "[TEST] Help A")!;
    expect(a.orgName).toContain("Help Org");
    expect(a.resources).toHaveLength(1);
    expect(a.resources[0]).toMatchObject({ name: "Bottled water", reportedStatus: "AVAILABLE" });
    expect(a.resources[0].categoryLabel).toBeTruthy();
    expect(a.resources[0].freshness).toBeTruthy();
  });
});
