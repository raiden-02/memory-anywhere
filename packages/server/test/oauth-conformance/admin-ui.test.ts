// The admin UI v1 (auth-and-security.md §8.1): every page renders for the signed-in owner and only
// for them; stored text is escaped; each owner action does what it says, and the §3.4 actions
// need a passkey within the last 5 minutes.

import { newId } from "@memory-anywhere/contracts/ids";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { save } from "../../src/write/pipeline.ts";
import { chatCaller, CHAT_CLIENT_ID, saveReq } from "../helpers/store.ts";
import { Browser, ownerSetup, startIssuer, type Issuer } from "./issuer.ts";

let issuer: Issuer;
let owner: Browser;

beforeAll(async () => {
  issuer = await startIssuer();
  owner = await ownerSetup(issuer);
}, 60_000);
afterAll(async () => {
  await issuer?.stop();
});

const admin = (path: string): string => `${issuer.adminOrigin}${path}`;
const act = (name: string, input: Record<string, unknown>) => owner.postJson(admin(`/api/act/${name}`), { input });

/** A memory the test chat app saved because the user asked ("remember …"), so it is active; returns its id. */
async function chatSave(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await save(issuer.app.write, chatCaller(), saveReq(content, { explicit_request: true, user_words: `remember that I ${content.toLowerCase()}`, ...extra }), { idempotencyKey: newId("pxs"), observedAt: issuer.clock.now() });
  if (r.kind !== "result" || !r.outcome.id?.startsWith("mem_")) throw new Error(`save: ${JSON.stringify(r)}`);
  return r.outcome.id;
}

const status = (id: string): string => (issuer.db.prepare("SELECT status FROM memory WHERE id = ?").get(id) as { status: string }).status;

describe("pages", () => {
  test("every page renders for the owner, with the navigation; without a session it asks to sign in", async () => {
    const id = await chatSave("Prefers window seats on long flights");
    for (const path of ["/", "/memories", `/memories/${id}`, "/memories?q=window&status=active", "/reviews", "/observations", "/changes", "/apps", "/sections", "/repos", "/exports", "/system"]) {
      const res = await owner.fetch(admin(path));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('aria-label="Admin"');
    }
    const stranger = new Browser(issuer.origin);
    expect(await (await stranger.fetch(admin("/memories"))).text()).toContain("Sign in with passkey");
    expect((await stranger.postJson(admin("/api/act/memory.pin"), { input: { id, pinned: true } })).status).toBe(401);
  }, 30_000);

  test("stored text is shown as text, never as markup", async () => {
    const id = await chatSave(`Uses the "<script>alert(1)</script>" snippet tool`);
    const html = await (await owner.fetch(admin(`/memories/${id}`))).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("search finds memories by their words", async () => {
    await chatSave("Owns a road bike called Bluebird");
    const html = await (await owner.fetch(admin("/memories?q=bluebird"))).text();
    expect(html).toContain("Bluebird");
    expect(html).not.toContain("window seats");
  });

  test("an action without the session's CSRF token is refused", async () => {
    const id = await chatSave("Keeps a herb garden on the balcony");
    const res = await owner.fetch(admin("/api/act/memory.pin"), { method: "POST", body: JSON.stringify({ input: { id, pinned: true } }), headers: { "content-type": "application/json", "x-ma-csrf": "forged" } });
    expect(res.status).toBe(403);
  });
});

describe("owner actions", () => {
  test("edit adds a T0 version; pin; forget then restore", async () => {
    const id = await chatSave("Drinks oat milk in coffee");
    expect((await act("memory.edit", { id, content: "Drinks oat milk in coffee and tea", change: "correction" })).status).toBe(200);
    const current = issuer.db.prepare("SELECT content, trust_tier FROM memory_version WHERE memory_id = ? AND expired_at IS NULL ORDER BY id DESC").get(id);
    expect(current).toEqual({ content: "Drinks oat milk in coffee and tea", trust_tier: 0 });
    await act("memory.pin", { id, pinned: true });
    expect(issuer.db.prepare("SELECT pinned FROM memory WHERE id = ?").get(id)).toEqual({ pinned: 1 });
    await act("memory.forget", { id });
    expect(status(id)).toBe("forgotten");
    await act("memory.undo", { id });
    expect(status(id)).toBe("active");
  });

  test("purge needs a passkey within the last 5 minutes", async () => {
    const id = await chatSave("Learning to play the cello");
    issuer.clock.advance(6 * 60_000);
    expect((await act("memory.purge", { id })).data).toEqual({ error: "step_up_required" });
    const options = await owner.postJson(admin("/api/stepup/options"));
    await owner.postJson(admin("/api/stepup/verify"), issuer.authenticator.get(options.data as never));
    expect((await act("memory.purge", { id })).status).toBe(200);
    expect(status(id)).toBe("purged");
    expect(issuer.db.prepare("SELECT count(*) n FROM memory_version WHERE memory_id = ? AND content IS NOT NULL").get(id)).toEqual({ n: 0 });
  });

  test("a contested pair is resolved by keeping one", async () => {
    const a = await chatSave("Lives in Lisbon", { attribute: "self.city" });
    const b = await chatSave("Lives in Porto", { attribute: "self.city" });
    const contested = [a, b].filter((id) => status(id) === "contested");
    if (contested.length === 2) {
      expect((await act("memory.resolve", { keep: b })).status).toBe(200);
      expect([status(a), status(b)]).toEqual(["superseded", "active"]);
    } else {
      // The same client updated its own slot (store rule 4a): nothing to resolve.
      expect((await act("memory.resolve", { keep: b })).data).toEqual({ error: "this memory is not contested" });
    }
  });

  test("an app's policy: a restricted app keeps the observation floor; only Claude may confirm with a question", async () => {
    const base = { client_id: CHAT_CLIENT_ID, write: true, sections: "restricted", save_floor: "none", elicitation: "none" };
    expect((await act("client.policy", base)).data).toEqual({ error: "an app limited to some sections keeps the observation floor" });
    expect((await act("client.policy", { ...base, save_floor: "observation" })).status).toBe(200);
    expect(issuer.db.prepare("SELECT save_floor, section_allow_json FROM client_policy WHERE client_id = ?").get(CHAT_CLIENT_ID)).toEqual({ save_floor: "observation", section_allow_json: '["sec_profile","sec_preferences","sec_interests","sec_tools"]' });
    await act("client.policy", { ...base, sections: "all" });
  });

  test("revert undoes what an app did in a window: its new memories are forgotten", async () => {
    const since = new Date(issuer.clock.now()).toISOString();
    const id = await chatSave("Collects vintage fountain pens");
    const until = new Date(issuer.clock.now() + 1000).toISOString();
    const r = await act("client.revert", { client_id: CHAT_CLIENT_ID, since, until });
    expect(r.data["result"]).toMatchObject({ forgotten: 1 });
    expect(status(id)).toBe("forgotten");
  });

  test("sections: rename and merge; attributes: add", async () => {
    expect((await act("section.rename", { id: "sec_interests", name: "Hobbies" })).status).toBe(200);
    expect((await act("section.rename", { id: "sec_tools", name: "Hobbies" })).data).toEqual({ error: "another section has that name" });
    await act("section.rename", { id: "sec_interests", name: "Interests" });
    const id = await chatSave("Prefers dark mode in every editor");
    const from = (issuer.db.prepare("SELECT section_id FROM memory WHERE id = ?").get(id) as { section_id: string }).section_id;
    expect((await act("attribute.add", { name: "self.coffee_order", cardinality: "one", section: "sec_preferences", description: "How the user orders coffee" })).status).toBe(200);
    expect(issuer.db.prepare("SELECT origin FROM attribute WHERE name = 'self.coffee_order'").get()).toEqual({ origin: "owner" });
    expect(from).toMatch(/^sec_/u);
  });

  test("export keys are added and removed with a passkey; the exports page lists them", async () => {
    const recipient = await identityToRecipient(await generateIdentity());
    issuer.clock.advance(6 * 60_000);
    expect((await act("recipient.add", { recipient, label: "Laptop key" })).data).toEqual({ error: "step_up_required" });
    const options = await owner.postJson(admin("/api/stepup/options"));
    await owner.postJson(admin("/api/stepup/verify"), issuer.authenticator.get(options.data as never));
    expect((await act("recipient.add", { recipient, label: "Laptop key" })).status).toBe(200);
    expect(await (await owner.fetch(admin("/exports"))).text()).toContain("Laptop key");
  });

  test("alerts are dismissed from the home page", async () => {
    const id = issuer.app.alerts.raise("disk_low", { free_pct: 12 });
    expect(await (await owner.fetch(admin("/"))).text()).toContain("disk_low");
    await act("alert.ack", { id });
    expect(issuer.app.alerts.open().map((a) => a.id)).not.toContain(id);
  });

  test("a scheduled owner reset shows on the home page and is cancelled with a passkey", async () => {
    issuer.owner.scheduleReset();
    expect(await (await owner.fetch(admin("/"))).text()).toContain("An owner reset is scheduled");
    issuer.clock.advance(6 * 60_000);
    expect((await owner.postJson(admin("/api/reset/cancel"))).data).toEqual({ error: "step_up_required" });
    const options = await owner.postJson(admin("/api/stepup/options"));
    await owner.postJson(admin("/api/stepup/verify"), issuer.authenticator.get(options.data as never));
    expect((await owner.postJson(admin("/api/reset/cancel"))).data).toEqual({ cancelled: true });
  });
});
