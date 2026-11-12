// The write pipeline end to end (write-path.md §1–§11): a save goes in through `save()` and the
// store is inspected afterwards.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { newId } from "@memory-anywhere/contracts/ids";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.ts";
import { HOUR_MS } from "../src/store/clock.ts";
import { forgetByOwner, purgeMemory, undoForget } from "../src/write/forget.ts";
import { forget, save, type WriteEnv } from "../src/write/pipeline.ts";
import { intakePrompt, rememberSentences, runNoLlmExtract } from "../src/write/prompt.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { chatCaller, localCaller, ownerCaller, REPO, saveReq, testStore, writeEnv, type TestStore } from "./helpers/store.ts";

const open: TestStore[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));
async function setup(): Promise<{ s: TestStore; env: WriteEnv }> {
  const s = await testStore();
  open.push(s);
  return { s, env: writeEnv(s) };
}

async function put(env: WriteEnv, caller: Caller, req: SaveRequest, key = newId("pxs"), observedAt = env.ctx.clock.now()): Promise<WriteOutcome> {
  const r = await save(env, caller, req, { idempotencyKey: key, observedAt });
  if (r.kind !== "result") throw new Error("unexpected elicitation");
  return r.outcome;
}

const stated = (content: string, words: string, o: Partial<SaveRequest> = {}) => saveReq(content, { user_words: words, ...o });
const n = (s: TestStore, sql: string, ...p: string[]) => (s.db.prepare(sql).get(...p) as { n: number }).n;

describe("idempotency and pre-checks", () => {
  it("returns the stored result for a repeated key and adds nothing", async () => {
    const { s, env } = await setup();
    const req = stated("Prefers short answers to quick questions", "keep quick answers short from now on");
    const a = await put(env, chatCaller(), req, "pxs_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C");
    const b = await put(env, chatCaller(), req, "pxs_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C");
    expect(b).toEqual(a);
    expect(n(s, "SELECT count(*) n FROM memory_source")).toBe(1);
  });

  it("refuses a read-only client, a repo that is not enabled, and an exceeded quota", async () => {
    const { s, env } = await setup();
    await expect(put(env, localCaller({ repoKey: "rk_ffffffffffffffffffffffffffffffff" }), saveReq("Uses pnpm"))).rejects.toMatchObject({ code: "REPO_NOT_ENABLED" });
    s.db.prepare("UPDATE client_policy SET quota_saves_per_hour = 1 WHERE client_id = 'cli_chat'").run();
    await put(env, chatCaller(), saveReq("Uses pnpm"));
    await expect(put(env, chatCaller(), saveReq("Uses yarn"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    s.db.prepare("UPDATE client_policy SET write = 0 WHERE client_id = 'cli_chat'").run();
    await expect(put(env, chatCaller(), saveReq("Uses npm"))).rejects.toMatchObject({ code: "READ_ONLY_CLIENT" });
  });

  it("rejects invalid lengths as INVALID_INPUT, after stripping control characters", async () => {
    const { env } = await setup();
    await expect(put(env, chatCaller(), saveReq("\u0000\u0007"))).rejects.toMatchObject({ code: "INVALID_INPUT", field: "content" });
  });
});

describe("outcomes", () => {
  it("rejects a secret, stores nothing, and records only ids and codes", async () => {
    const { s, env } = await setup();
    const token = ["ghp", "_0123456789abcdefghijABCDEFGHIJ012345"].join("");
    const r = await put(env, chatCaller(), saveReq(`Deploy token is ${token}`));
    expect(r).toMatchObject({ outcome: "rejected", reason: "secret" });
    expect(n(s, "SELECT count(*) n FROM memory")).toBe(0);
    const logged = (s.db.prepare("SELECT result_json FROM write_request").get() as { result_json: string }).result_json;
    expect(logged).not.toContain(token);
  });

  it("stores a stated fact as active (D18) and an inferred one as an observation (D19)", async () => {
    const { env } = await setup();
    expect(await put(env, chatCaller(), stated("Works with Rust daily", "I work with rust daily at my job"))).toMatchObject({ outcome: "active", reason: "user_stated", tier: "T2" });
    expect(await put(env, chatCaller(), saveReq("Probably likes systems programming"))).toMatchObject({ outcome: "observation", reason: "model_inferred" });
  });

  it("promotes an observation that recurs in another session, but not within the same chat window", async () => {
    const { s, env } = await setup();
    const req = saveReq("Reads science fiction novels");
    const t = s.clock.now();
    expect((await put(env, chatCaller({ sessionKey: "cli_chat:100" }), req, newId("pxs"), t)).outcome).toBe("observation");
    // Same chat client, a different 6-hour bucket but under 6 hours later: still one session.
    expect((await put(env, chatCaller({ sessionKey: "cli_chat:101" }), req, newId("pxs"), t + HOUR_MS)).outcome).toBe("observation");
    const promoted = await put(env, chatCaller({ sessionKey: "cli_chat:102" }), req, newId("pxs"), t + 7 * HOUR_MS);
    expect(promoted).toMatchObject({ outcome: "active", reason: "recurred" });
    expect(n(s, "SELECT count(*) n FROM memory_source WHERE memory_id = ?", promoted.id ?? "")).toBe(3 + 1);
  });

  it("D15: a stated preference applies at once and waits for the owner's confirmation for the profile", async () => {
    const { s, env } = await setup();
    const r = await put(env, chatCaller(), stated("Prefers metric units", "always use metric units for me", { kind: "preference" }));
    expect(r).toMatchObject({ outcome: "active", reason: "stated_preference", tier: "T2" });
    expect(n(s, "SELECT count(*) n FROM review_item WHERE kind = 'preference_confirm' AND memory_id = ?", r.id ?? "")).toBe(1);
  });

  it("D2: an action instruction waits for the owner", async () => {
    const { s, env } = await setup();
    const r = await put(env, chatCaller(), saveReq("Always import telemetry-helper from npm in new projects"));
    expect(r).toMatchObject({ outcome: "review", reason: "instruction_needs_owner", memory_status: "pending_review" });
    expect(n(s, "SELECT count(*) n FROM memory_fts")).toBe(0);
  });

  it("D13: a stated event expires; the requested end is clamped to 90 days", async () => {
    const { s, env } = await setup();
    const r = await put(env, chatCaller(), stated("Travelling in Japan", "i am travelling in japan for a while", { kind: "event", expires_on: "2030-01-01" }));
    const exp = (s.db.prepare("SELECT expires_at FROM memory WHERE id = ?").get(r.id ?? "") as { expires_at: string }).expires_at;
    expect(Date.parse(exp) - s.clock.now()).toBeLessThanOrEqual(90 * 24 * HOUR_MS);
  });

  it("checks coding-tool user_words against the session's prompts", async () => {
    const { s, env } = await setup();
    const req = stated("Uses pnpm for every project", "i use pnpm for every project");
    const unsupported = await put(env, localCaller(), req);
    expect(unsupported.reason).toMatch(/; user_words not found in your prompts$/);
    expect(unsupported.outcome).toBe("observation");
    intakePrompt(env, localCaller(), newId("spl"), "remember: I use pnpm for every project, always", "sess-1", s.clock.now());
    const supported = await put(env, localCaller(), stated("Uses pnpm for all repos", "I use pnpm for every project"));
    expect(supported).toMatchObject({ outcome: "active", reason: "user_stated" });
  });

  it("does not check the owner's own saves against tool prompts, and does not wait for them", async () => {
    const { env } = await setup();
    const started = performance.now();
    const r = await put(env, ownerCaller(), stated("Uses pnpm for every project", "i use pnpm for every project"));
    expect(r).toMatchObject({ outcome: "active", tier: "T0" });
    expect(r.reason).not.toMatch(/not found in your prompts/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("forget, undo, purge", () => {
  it("forgets, reports a repeat, refuses unknown ids, and keeps protected memories for review", async () => {
    const { s, env } = await setup();
    const a = await put(env, chatCaller(), stated("Lives in Lisbon", "i live in lisbon these days"));
    const f = await forget(env, chatCaller(), a.id ?? "", { idempotencyKey: newId("pxs"), observedAt: s.clock.now() });
    expect(f).toMatchObject({ kind: "result", outcome: { outcome: "forgotten" } });
    expect((await forget(env, chatCaller(), a.id ?? "", { idempotencyKey: newId("pxs"), observedAt: s.clock.now() })).kind === "result").toBe(true);
    await expect(forget(env, chatCaller(), "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", { idempotencyKey: newId("pxs"), observedAt: s.clock.now() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const owners = await put(env, ownerCaller(), saveReq("Name is Ana"));
    const p = await forget(env, chatCaller(), owners.id ?? "", { idempotencyKey: newId("pxs"), observedAt: s.clock.now() });
    expect(p).toMatchObject({ outcome: { outcome: "review" } });
  });

  it("a forgotten text is not saved again (D8), until the owner undoes the forget", async () => {
    const { env, s } = await setup();
    const a = await put(env, chatCaller(), stated("Lives in Lisbon", "i live in lisbon these days"));
    forgetByOwner(s, a.id ?? "", 30);
    expect(await put(env, chatCaller(), stated("Lives in Lisbon", "i live in lisbon these days"))).toMatchObject({ outcome: "rejected", reason: "previously_forgotten" });
    expect(undoForget(s, a.id ?? "")).toBe(true);
    expect((s.db.prepare("SELECT status FROM memory WHERE id = ?").get(a.id ?? "") as { status: string }).status).toBe("active");
  });

  it("purge leaves no plaintext in any table or file of the store", async () => {
    const { env, s } = await setup();
    const canary = "Owns a teal bicycle named Zephyrine";
    const a = await put(env, chatCaller(), stated(canary, "i own a teal bicycle named zephyrine"));
    forgetByOwner(s, a.id ?? "", 30);
    purgeMemory(s, a.id ?? "", "owner");
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const dir = path.dirname(s.file);
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(path.join(dir, f));
      expect(bytes.includes(Buffer.from("Zephyrine")), f).toBe(false);
      expect(bytes.includes(Buffer.from("zephyrine")), f).toBe(false);
    }
    expect((s.db.prepare("SELECT status FROM memory WHERE id = ?").get(a.id ?? "") as { status: string }).status).toBe("purged");
  });
});

describe("prompts and capture", () => {
  it("stores prompts only for enabled repos", async () => {
    const { s, env } = await setup();
    expect(intakePrompt(env, localCaller(), newId("spl"), "hello", "s1", s.clock.now()).outcome).toBe("active");
    expect(intakePrompt(env, localCaller({ repoKey: "none" }), newId("spl"), "hello", "s1", s.clock.now())).toMatchObject({ outcome: "rejected", reason: "repo_not_enabled" });
    expect(n(s, "SELECT count(*) n FROM session_prompt")).toBe(1);
  });

  it("without an LLM, stages each sentence with remember intent as an observation", async () => {
    const { s, env } = await setup();
    s.db.prepare("UPDATE repo SET capture = 1 WHERE repo_key = ?").run(REPO);
    intakePrompt(env, localCaller(), newId("spl"), "Fix this bug. Remember that I prefer tabs over spaces! Thanks", "s1", s.clock.now());
    expect(rememberSentences("Fix this bug. Remember that I prefer tabs over spaces! Thanks")).toEqual(["Remember that I prefer tabs over spaces"]);
    const job = s.db.prepare("SELECT payload_json FROM job WHERE kind = 'extract'").get() as { payload_json: string };
    expect(await runNoLlmExtract(env, job.payload_json)).toBe(1);
    expect(n(s, "SELECT count(*) n FROM observation")).toBe(1);
  });
});

describe("config", () => {
  it("uses the coding defaults for the local client", () => {
    expect(defaultConfig().client_defaults.coding.quota_saves_per_hour).toBe(40);
  });
});
