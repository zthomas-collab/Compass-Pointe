/** Demo learning-library content (idempotent). Local demo only; the video is a public YouTube link used as a stand-in. */
import type { Driver } from "../src/server/db";
import { runIn } from "../src/server/db/context";
import { submitResource } from "../src/server/modules/learning";

export async function seedDemoLearning(db: Driver): Promise<string[]> {
  const sys = <T>(fn: (tx: import("../src/server/db").Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
  if ((await sys((tx) => tx.query(`SELECT 1 FROM learning_resources WHERE title LIKE '[DEMO]%' LIMIT 1`))).length) return [];
  const id = async (email: string) => (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])))[0]?.id;
  const exec = await id("admin@crisiscompass.test");
  const editor = await id("pantry.editor@example.invalid");
  const org = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM organizations WHERE display_name LIKE '%Blue Ridge Community Pantry%' LIMIT 1`)))[0]?.id;
  if (!exec) return [];
  await submitResource(db, exec, {
    title: "[DEMO] How to build a 72-hour emergency kit", description: "A short video walkthrough of what to pack for the first three days after a storm.",
    category: "PREPAREDNESS", kind: "VIDEO", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  await submitResource(db, exec, {
    title: "[DEMO] Requesting help: what to expect, step by step", description: "A plain-language guide to the request form, what staff review, and how you are updated.",
    category: "APPLICATION_WALKTHROUGH", kind: "ARTICLE",
    body: "Create a free account with your email address. You will get a link by email; there is no password to remember.\n\nChoose the kind of help you need, your county and ZIP code, and describe your situation in your own words. Do not include Social Security numbers or bank details.\n\nCounty staff review each request. You can see its status at any time, reply if staff ask a question, add documents, or withdraw the request.\n\nIf you agreed to sharing, an approved organization may be asked to help. Submitting a request does not guarantee assistance. In a life-threatening emergency, call 911.",
  });
  if (editor && org) {
    const pending = await submitResource(db, editor, {
      title: "[DEMO] Volunteer orientation for food distribution", description: "What new volunteers should know before their first shift at a food distribution site.",
      category: "VOLUNTEER_ONBOARDING", kind: "ARTICLE", orgId: org,
      body: "Arrive ten minutes early and sign in with the site lead. Wear closed-toe shoes and keep your phone available for shift updates.\n\nFollow food-safety instructions at all times, lift with your legs, and ask for help with heavy pallets.\n\nTreat every neighbor with dignity. Do not photograph people or record names without their permission.",
    });
    void pending; // left waiting so the moderation queue has something to review
  }
  return ["Learning library: two published demo items and one waiting for review"];
}
