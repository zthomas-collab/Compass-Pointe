import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  editResource, getMine, getPublicResource, listForModeration, listMine, listPublicResources, moderateResource, submitResource,
} from "@/server/modules/learning";
import { parseYouTubeId, youTubeEmbedUrl } from "@/lib/youtube";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, countyAdmin: string, orgMember: string, otherMember: string, stranger: string;
let orgP: string, orgQ: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const video = (over: Record<string, unknown> = {}) => ({
  title: "How to prepare a go-bag", description: "A short video on what to pack before a storm arrives.", category: "PREPAREDNESS", kind: "VIDEO", url: VIDEO, ...over,
});
const article = (over: Record<string, unknown> = {}) => ({
  title: "Applying for assistance step by step", description: "A written walkthrough of the request form.", category: "APPLICATION_WALKTHROUGH", kind: "ARTICLE",
  body: "First, create an account with your email address. Then choose the kind of help you need and describe your situation in your own words.", ...over,
});

beforeAll(async () => {
  db = await freshDb();
  [exec, countyAdmin, orgMember, otherMember, stranger] = await Promise.all(["exec", "county", "org-member", "other-member", "stranger"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  const county = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "county@example.test", countyId: county, reason: "County coordinator" });
  orgP = await makeOrg(db, { name: "Relief P", consent: true, members: [{ userId: orgMember, role: "EDITOR" }] });
  orgQ = await makeOrg(db, { name: "Other Q", members: [{ userId: otherMember, role: "EDITOR" }] });
});
afterAll(async () => db?.close());

describe("YouTube links", () => {
  it("accepts watch, share, embed, shorts and live links and keeps only the video id", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123", "https://youtu.be/dQw4w9WgXcQ?si=abc", "https://youtube.com/embed/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "http://youtu.be/dQw4w9WgXcQ",
    ]) expect(parseYouTubeId(u)).toBe("dQw4w9WgXcQ");
    expect(youTubeEmbedUrl("dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0");
  });

  it("rejects other hosts, look-alike hosts, script and data URLs, credentials and malformed ids", () => {
    for (const u of [
      "https://vimeo.com/123456789", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://evil.example/youtu.be/dQw4w9WgXcQ", "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E%3Cscript%3E", "dQw4w9WgXcQ", "", "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    ]) expect(parseYouTubeId(u)).toBeNull();
    expect(() => youTubeEmbedUrl('x"><script>')).toThrow();
  });
});

describe("submission and moderation", () => {
  it("executives publish directly; everyone else waits for review", async () => {
    const e = await submitResource(db, exec, video());
    expect(e.status).toBe("PUBLISHED");
    const o = await submitResource(db, orgMember, video({ orgId: orgP }));
    const c = await submitResource(db, countyAdmin, article());
    expect(o.status).toBe("PENDING_REVIEW");
    expect(c.status).toBe("PENDING_REVIEW");
    expect(await getPublicResource(db, o.id)).toBeNull(); // not public until approved
    expect(await getPublicResource(db, e.id)).not.toBeNull();
  });

  it("only administrators and organization members can submit, only for their own organization, and only valid content", async () => {
    expect(await code(submitResource(db, stranger, video()))).toBe("FORBIDDEN");
    expect(await code(submitResource(db, orgMember, video({ orgId: orgQ })))).toBe("FORBIDDEN");
    expect(await code(submitResource(db, orgMember, video()))).toBe("VALIDATION"); // an organization member must name the organization
    expect(await code(submitResource(db, orgMember, video({ orgId: orgP, url: "https://vimeo.com/123" })))).toBe("VALIDATION");
    expect(await code(submitResource(db, orgMember, article({ orgId: orgP, body: "too short" })))).toBe("VALIDATION");
    expect(await code(submitResource(db, orgMember, video({ orgId: orgP, category: "NOPE" })))).toBe("VALIDATION");
  });

  it("only an executive moderates; rejecting needs a reason; a rejected item can be fixed and resubmitted by its own organization only", async () => {
    const item = await submitResource(db, orgMember, video({ orgId: orgP, title: "Needs fixing video" }));
    expect(await code(moderateResource(db, orgMember, { resourceId: item.id, decision: "publish" }))).toBe("FORBIDDEN");
    expect(await code(moderateResource(db, countyAdmin, { resourceId: item.id, decision: "publish" }))).toBe("FORBIDDEN");
    expect(await code(moderateResource(db, exec, { resourceId: item.id, decision: "reject" }))).toBe("VALIDATION");
    await moderateResource(db, exec, { resourceId: item.id, decision: "reject", note: "The audio is unclear; please upload a clearer version." });
    const mine = (await listMine(db, orgMember)).find((r) => r.id === item.id)!;
    expect(mine).toMatchObject({ status: "REJECTED", reviewNote: expect.stringContaining("audio is unclear") });
    expect(await code(editResource(db, otherMember, { resourceId: item.id, title: "Hijacked title here", description: "Trying to edit another organization's item.", category: "OTHER", url: VIDEO }))).toBe("NOT_FOUND");
    await editResource(db, orgMember, { resourceId: item.id, title: "Clearer audio video", description: "A re-recorded version with clearer audio.", category: "PREPAREDNESS", url: "https://youtu.be/9bZkp7q19f0" });
    const again = await getMine(db, orgMember, item.id);
    expect(again).toMatchObject({ status: "PENDING_REVIEW", youtubeId: "9bZkp7q19f0", title: "Clearer audio video" });
    await moderateResource(db, exec, { resourceId: item.id, decision: "publish" });
    const pub = await getPublicResource(db, item.id);
    expect(pub).toMatchObject({ title: "Clearer audio video", youtubeId: "9bZkp7q19f0", orgName: expect.stringContaining("Relief P") });
  });

  it("editing published content by a non-executive sends it back to review and removes it from public view", async () => {
    const item = await submitResource(db, orgMember, article({ orgId: orgP, title: "Published then edited" }));
    await moderateResource(db, exec, { resourceId: item.id, decision: "publish" });
    expect(await getPublicResource(db, item.id)).not.toBeNull();
    await editResource(db, orgMember, { resourceId: item.id, title: "Published then edited v2", description: "Changed after publication.", category: "RECOVERY", body: article().body });
    expect(await getPublicResource(db, item.id)).toBeNull();
    expect((await getMine(db, orgMember, item.id)).status).toBe("PENDING_REVIEW");
  });

  it("archives, re-publishes and stamps periodic reviews; illegal moves are refused by the code and the database", async () => {
    const item = await submitResource(db, exec, article({ title: "Archive me article" }));
    expect(await code(moderateResource(db, exec, { resourceId: item.id, decision: "reject", note: "Not appropriate to reject published item" }))).toBe("CONFLICT");
    await moderateResource(db, exec, { resourceId: item.id, decision: "review" });
    await moderateResource(db, exec, { resourceId: item.id, decision: "archive" });
    expect(await getPublicResource(db, item.id)).toBeNull();
    expect(await code(moderateResource(db, exec, { resourceId: item.id, decision: "review" }))).toBe("CONFLICT");
    await moderateResource(db, exec, { resourceId: item.id, decision: "publish" });
    expect(await getPublicResource(db, item.id)).not.toBeNull();
    await expect(sys((tx) => tx.query(`UPDATE learning_resources SET status = 'REJECTED' WHERE id = $1`, [item.id]))).rejects.toThrow(); // PUBLISHED -> REJECTED is not a legal move
    await expect(sys((tx) => tx.query(`UPDATE learning_resources SET youtube_id = 'abc' WHERE id = $1`, [item.id]))).rejects.toThrow(); // constraints hold at the database
  });
});

describe("what people can see", () => {
  it("the public sees only published items with no review notes, submitters or unapproved organization names", async () => {
    const hidden = await submitResource(db, orgMember, video({ orgId: orgP, title: "PENDING-SECRET-TITLE video" }));
    const secretOrg = await submitResource(db, otherMember, video({ orgId: orgQ, title: "Item from unapproved profile" }));
    await moderateResource(db, exec, { resourceId: secretOrg.id, decision: "publish", note: "INTERNAL-REVIEW-NOTE" });
    const list = await listPublicResources(db);
    const blob = JSON.stringify(list);
    expect(blob).not.toContain("PENDING-SECRET-TITLE");
    expect(blob).not.toContain("INTERNAL-REVIEW-NOTE");
    expect(blob).not.toContain("@example.test");
    expect(list.find((r) => r.id === secretOrg.id)!.orgName).toBeNull(); // orgQ has no approved public profile
    expect(list.find((r) => r.id === hidden.id)).toBeUndefined();
    expect((await listPublicResources(db, { category: "APPLICATION_WALKTHROUGH" })).every((r) => r.category === "APPLICATION_WALKTHROUGH")).toBe(true);
    expect((await listPublicResources(db, { q: "go-bag" })).length).toBeGreaterThan(0);
    expect(await listPublicResources(db, { q: "zzzz-no-match" })).toEqual([]);
    expect(await getPublicResource(db, "not-a-uuid")).toBeNull();
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM learning_resources`))).rejects.toThrow();
  });

  it("an organization sees its own submissions; strangers and other organizations see none; the moderation queue is executive-only", async () => {
    const mine = await listMine(db, orgMember);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.orgName !== null && r.orgName.includes("Relief P"))).toBe(true);
    expect((await listMine(db, otherMember)).some((r) => r.orgName?.includes("Relief P"))).toBe(false);
    expect(await code(listMine(db, stranger))).toBe("FORBIDDEN");
    expect(await code(listForModeration(db, orgMember))).toBe("FORBIDDEN");
    expect((await listForModeration(db, exec, "PENDING_REVIEW")).every((r) => r.status === "PENDING_REVIEW")).toBe(true);
    expect((await listForModeration(db, exec, "PENDING_REVIEW"))[0].submitterEmail).toContain("@example.test");
  });

  it("article text is stored as plain text and returned unchanged for escaped rendering", async () => {
    const body = "<script>alert('x')</script> " + article().body;
    const item = await submitResource(db, exec, article({ title: "Markup stays text", body }));
    const pub = await getPublicResource(db, item.id);
    expect(pub!.body).toBe(body); // stored verbatim; React escapes it on render, so it can never execute
  });
});
