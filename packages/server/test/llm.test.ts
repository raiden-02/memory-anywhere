// The LLM adapter and its two M2 calls (write-path.md §6.2, memory-policy.md §7.3), with a scripted
// provider: every fallback (none, no key, cap, timeout, error), the cache and spend, the slot
// proposal that fills or contests but never supersedes (spec-issues #53), the reslot job, and the
// sensitive check that can only add a flag.

import { afterEach, describe, expect, test } from "vitest";
import { App } from "../src/app.ts";
import { defaultConfig, type ServerConfigT } from "../src/config/schema.ts";
import { anthropicProvider, Llm, providerFromEnv } from "../src/llm/adapter.ts";
import { sensitiveCheck, slotProposal } from "../src/llm/prompts.ts";
import { ReslotRetry, runReslot } from "../src/llm/slots.ts";
import { iso } from "../src/store/clock.ts";
import { save } from "../src/write/pipeline.ts";
import { sensitiveCategory } from "../src/write/screens.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { answers, fakeProvider, timeout, type FakeProvider } from "./helpers/llm.ts";
import { chatCaller, fakeEmbedder, localCaller, testStore, type TestStore } from "./helpers/store.ts";

function llmConfig(over: { provider?: "anthropic" | "none"; llmCheck?: boolean; blocked?: ServerConfigT["sensitive"]["blocked"] } = {}): ServerConfigT {
  const base = defaultConfig();
  return {
    ...base,
    llm: { ...base.llm, provider: over.provider ?? "anthropic" },
    sensitive: { blocked: over.blocked ?? base.sensitive.blocked, llm_check: over.llmCheck ?? true },
  };
}

let s: TestStore | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

/** A fresh store and App; `key: false` starts it without a key, so the fake is never reached. */
async function setup(o: { key?: boolean; config?: ServerConfigT } = {}): Promise<{ app: App; fake: FakeProvider; s: TestStore }> {
  s = await testStore({ memory: true });
  const fake = fakeProvider();
  const app = new App({ db: s.db, config: o.config ?? llmConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids, ...(o.key === false ? {} : { llmProvider: fake }) });
  return { app, fake, s };
}

let n = 0;
/** A user-stated fact from a chat app (T2): the user's words are the content. */
async function said(app: App, content: string, caller: Caller = chatCaller(), over: Partial<SaveRequest> = {}): Promise<WriteOutcome> {
  const req: SaveRequest = { content, kind: "fact", why_durable: "a lasting fact", user_words: content.toLowerCase(), explicit_request: false, entity: "self", scope: "global", change: "update", ...over };
  const r = await save(app.write, caller, req, { idempotencyKey: `llm-test-${++n}`, observedAt: app.ctx.clock.now() });
  if (r.kind !== "result") throw new Error("unexpected elicitation");
  return r.outcome;
}

const row = (app: App, id: string) =>
  app.ctx.db.prepare("SELECT attribute_id, section_id, status FROM memory WHERE id = ?").get(id) as { attribute_id: string | null; section_id: string; status: string };

describe("slot proposal", () => {
  test("fills an empty slot, then the table decides from D14 on the new resolution", async () => {
    const { app, fake } = await setup();
    fake.script = answers({ slot: "city" });
    const out = await said(app, "Calls Lisbon home these days");
    expect(out).toMatchObject({ outcome: "active", reason: "slot_fact" });
    expect(row(app, out.id ?? "")).toMatchObject({ attribute_id: "att_city", section_id: "sec_profile", status: "active" });
    expect(fake.calls.map((c) => c.name)).toEqual(["sensitive_check", "slot_proposal"]);
  });

  test("never supersedes: a filled slot becomes a contested pair, the current value stays current", async () => {
    const { app, fake } = await setup();
    const paris = await said(app, "Lives in Paris"); // the pattern slot: no proposal asked
    expect(fake.calls.map((c) => c.name)).toEqual(["sensitive_check"]);
    fake.script = answers({ slot: "city" });
    const lisbon = await said(app, "Calls Lisbon home these days");
    expect(lisbon).toMatchObject({ outcome: "active", reason: "contested", contested_with: [paris.id] });
    expect(row(app, paris.id ?? "").status).toBe("contested");
    const open = app.ctx.db.prepare("SELECT count(*) AS n FROM memory_version WHERE memory_id = ? AND valid_to IS NULL AND expired_at IS NULL").get(paris.id ?? "") as { n: number };
    expect(open.n).toBe(1);
  });

  test("a value that only rephrases the slot's value is the same fact, linked as a source", async () => {
    const { app, fake } = await setup();
    const paris = await said(app, "Lives in Paris");
    fake.script = answers({ slot: "city" });
    const again = await said(app, "In Paris, lives");
    expect(again).toMatchObject({ reason: "already_stored", id: paris.id });
    expect(row(app, paris.id ?? "").status).toBe("active");
  });

  test("an answer that does not fit the entity, or names a restricted attribute, is dropped", async () => {
    const { app, fake } = await setup();
    fake.script = answers({ slot: "project.status" });
    const out = await said(app, "Calls Lisbon home these days");
    expect(row(app, out.id ?? "").attribute_id).toBeNull();
    const choices = fake.calls.find((c) => c.name === "slot_proposal")?.user ?? "";
    expect(choices).not.toContain("project.repo");
    expect(choices).not.toContain("person.relation");
  });

  test("a timeout stores the memory unslotted; the reslot job fills the empty slot later", async () => {
    const { app, fake } = await setup();
    fake.script = (call) => (call.name === "slot_proposal" ? timeout() : { sensitive_category: "none" });
    const out = await said(app, "Calls Lisbon home these days");
    expect(out.outcome).toBe("active");
    expect(row(app, out.id ?? "").attribute_id).toBeNull();
    const job = app.ctx.db.prepare("SELECT payload_json, next_at FROM job WHERE kind = 'reslot'").get() as { payload_json: string; next_at: string };
    expect(JSON.parse(job.payload_json)).toEqual({ memory_id: out.id });
    expect(Date.parse(job.next_at)).toBeGreaterThan(app.ctx.clock.now());

    // Still too slow: the worker retries.
    await expect(runReslot(app.ctx, app.llm, job.payload_json)).rejects.toBeInstanceOf(ReslotRetry);
    fake.script = answers({ slot: "city" });
    expect(await runReslot(app.ctx, app.llm, job.payload_json)).toEqual([out.id]);
    expect(row(app, out.id ?? "")).toMatchObject({ attribute_id: "att_city", section_id: "sec_profile", status: "active" });
    // Done once: a second run changes nothing.
    expect(await runReslot(app.ctx, app.llm, job.payload_json)).toEqual([]);
  });

  test("a reslot into a filled slot contests it and never supersedes", async () => {
    const { app, fake } = await setup();
    const paris = await said(app, "Lives in Paris");
    fake.script = (call) => (call.name === "slot_proposal" ? timeout() : { sensitive_category: "none" });
    const lisbon = await said(app, "Calls Lisbon home these days");
    fake.script = answers({ slot: "city" });
    const job = app.ctx.db.prepare("SELECT payload_json FROM job WHERE kind = 'reslot'").get() as { payload_json: string };
    expect((await runReslot(app.ctx, app.llm, job.payload_json)).sort()).toEqual([lisbon.id, paris.id].sort());
    expect(row(app, paris.id ?? "").status).toBe("contested");
    expect(row(app, lisbon.id ?? "")).toMatchObject({ attribute_id: "att_city", status: "contested" });
  });

  test("an API error falls back like a timeout", async () => {
    const { app, fake } = await setup();
    fake.script = (call) => {
      if (call.name === "slot_proposal") throw Object.assign(new Error("overloaded"), { name: "InternalServerError" });
      return { sensitive_category: "none" };
    };
    const out = await said(app, "Calls Lisbon home these days");
    expect(out.outcome).toBe("active");
    expect(app.ctx.db.prepare("SELECT count(*) AS n FROM job WHERE kind = 'reslot'").get()).toEqual({ n: 1 });
  });
});

describe("sensitive check", () => {
  const content = "Sees Dr. Patel about the knee every Tuesday";

  test("adds a category the lexicons missed, so the save is treated as sensitive", async () => {
    expect(sensitiveCategory([content, content.toLowerCase()], defaultConfig().sensitive.blocked)).toBeUndefined();
    const { app, fake } = await setup();
    fake.script = answers({ sensitive: "health" });
    expect(await said(app, content)).toMatchObject({ outcome: "rejected", reason: "sensitive_not_requested" });
  });

  test("is skipped when llm_check is off, and ignores a category the owner does not block", async () => {
    const off = await setup({ config: llmConfig({ llmCheck: false }) });
    off.fake.script = answers({ sensitive: "health" });
    expect((await said(off.app, content)).outcome).toBe("active");
    expect(off.fake.calls.map((c) => c.name)).toEqual(["slot_proposal"]);
    s?.close();

    const unblocked = await setup({ config: llmConfig({ blocked: ["finances"] }) });
    unblocked.fake.script = answers({ sensitive: "health" });
    expect((await said(unblocked.app, content)).outcome).toBe("active");
  });

  test("can never remove a lexicon flag, and is not asked about secrets or flagged text", async () => {
    const { app, fake } = await setup();
    fake.script = answers({ sensitive: "none" });
    expect(await said(app, "Was diagnosed with asthma as a child")).toMatchObject({ outcome: "rejected", reason: "sensitive_not_requested" });
    expect(fake.calls.filter((c) => c.name === "sensitive_check")).toHaveLength(0);
  });
});

describe("fallbacks", () => {
  test("provider none never calls the model, even with a provider at hand", async () => {
    const { app, fake } = await setup({ config: llmConfig({ provider: "none" }) });
    fake.script = answers({ slot: "city", sensitive: "health" });
    expect((await said(app, "Calls Lisbon home these days")).outcome).toBe("active");
    expect(fake.calls).toHaveLength(0);
    expect(app.llm.degraded()).toBeUndefined();
  });

  test("capture never calls the model (spec-issues #54) and stages its candidates", async () => {
    const { app, fake } = await setup();
    const capture = localCaller({ channel: "capture" });
    const out = await said(app, "Calls Lisbon home these days", capture);
    expect(out).toMatchObject({ outcome: "observation", reason: "capture_no_llm" });
    expect(fake.calls).toHaveLength(0);
  });

  test("no key: behaves as none, reports llm_unavailable, and a key's arrival queues reslots", async () => {
    const { app, s: store } = await setup({ key: false });
    expect(app.llm.degraded()).toBe("llm_unavailable");
    const out = await said(app, "Calls Lisbon home these days");
    expect(out.outcome).toBe("active");
    expect(app.ctx.db.prepare("SELECT count(*) AS n FROM job WHERE kind = 'reslot'").get()).toEqual({ n: 0 });

    // The server restarts with a key: the save above gets its slot proposal.
    const withKey = new App({ db: store.db, config: llmConfig(), embedder: fakeEmbedder, clock: store.clock, ids: store.ids, llmProvider: fakeProvider() });
    const jobs = withKey.ctx.db.prepare("SELECT payload_json FROM job WHERE kind = 'reslot'").all() as { payload_json: string }[];
    expect(jobs.map((j) => JSON.parse(j.payload_json))).toEqual([{ memory_id: out.id }]);
    expect(withKey.ctx.db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'llm_key_missing_since'").get()).toEqual({ n: 0 });
  });

  test("the daily cap: behaves as none, raises llm_cap, reports it in memory_status", async () => {
    const { app, fake } = await setup();
    app.ctx.db.prepare("INSERT INTO llm_spend (day, purpose, usd) VALUES (?, 'live', 1.0)").run(iso(app.ctx.clock.now()).slice(0, 10));
    fake.script = answers({ slot: "city" });
    const out = await said(app, "Calls Lisbon home these days");
    expect(out.outcome).toBe("active");
    expect(fake.calls).toHaveLength(0);
    expect(app.llm.degraded()).toBe("llm_cap");
    expect(app.alerts.open().map((a) => a.kind)).toContain("llm_cap");
    // Capped saves are retried by the reslot job once the cap resets.
    expect(app.ctx.db.prepare("SELECT count(*) AS n FROM job WHERE kind = 'reslot'").get()).toEqual({ n: 1 });
  });

  test("an answer outside the schema counts as an error, not an answer", async () => {
    const { app, fake } = await setup();
    fake.script = () => ({ sensitive_category: "weather" });
    expect(await app.llm.ask(sensitiveCheck("Likes rain"))).toEqual({ ok: false, why: "error" });
  });
});

describe("cache and spend", () => {
  test("the same call is answered once; spend is recorded per UTC day from the token counts", async () => {
    const { app, fake } = await setup();
    fake.script = answers({ sensitive: "none" });
    const call = sensitiveCheck("Likes rain");
    expect(await app.llm.ask(call)).toEqual({ ok: true, value: { sensitive_category: "none" } });
    expect(await app.llm.ask(call)).toEqual({ ok: true, value: { sensitive_category: "none" } });
    expect(fake.calls).toHaveLength(1);
    const spend = app.ctx.db.prepare("SELECT usd, tokens_in, tokens_out FROM llm_spend WHERE purpose = 'live'").get() as { usd: number; tokens_in: number; tokens_out: number };
    expect(spend).toMatchObject({ tokens_in: 400, tokens_out: 10 });
    expect(spend.usd).toBeCloseTo((400 * 0.1 + 10 * 0.5) / 1e6, 12);
    const cached = app.ctx.db.prepare("SELECT prompt_version, model_id FROM extraction_cache").get();
    expect(cached).toEqual({ prompt_version: "sensitive_check/1", model_id: "claude-haiku-5-5" });
  });

  test("the Anthropic provider loads, and the SDK accepts both calls' answer schemas", async () => {
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const choices = [{ name: "city", entityType: "self", description: "The city the user lives in" }];
    for (const call of [slotProposal({ content: "x", entity: "self", entityType: "self", choices }), sensitiveCheck("x")]) {
      expect(zodOutputFormat(call.schema)).toMatchObject({ type: "json_schema" });
    }
    const provider = await anthropicProvider("sk-ant-test-not-a-real-key", "claude-haiku-5-5");
    expect(provider.modelId).toBe("claude-haiku-5-5");
    expect(await providerFromEnv(llmConfig(), {})).toBeUndefined();
    expect(await providerFromEnv(llmConfig({ provider: "none" }), { MA_LLM_API_KEY: "sk-ant-test" })).toBeUndefined();
  });

  test("a model without a price is refused at start", async () => {
    s = await testStore({ memory: true });
    const store = s;
    const unpriced = { ...fakeProvider(), modelId: "claude-unknown-0" };
    expect(() => new Llm({ ctx: store, config: llmConfig(), provider: unpriced })).toThrow(/no price/u);
  });
});
