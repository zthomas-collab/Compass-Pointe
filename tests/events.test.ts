import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { AppError } from "@/server/errors";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { createEvent, getEventAdmin, listEventsAdmin, setEventStatus, slugify, updateEvent } from "@/server/modules/events";
import { freshDb } from "./helpers/db";
import { grantRole, makeUser } from "./helpers/fixtures";

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
