// Purge scope (data-model.md §9), one test per place a purged text could survive. Each test saves
// a memory carrying a canary word nobody else uses, purges it, and checks that place. The stores are
// on disk, in a folder with a space in its path, so file checks read the real database, WAL and
// shared-memory files. Suite S maps its S-PURGE cases to these tests (evals/datasets/s/attacks.jsonl).

import { linkSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId } from "@memory-anywhere/contracts/ids";
import { afterEach, expect, test } from "vitest";
import { storeExport } from "../src/ops/export.ts";
import { compactStore, zeroAndDelete } from "../src/ops/compact.ts";
import { DAY_MS } from "../src/store/clock.ts";
import { forgetByOwner, purgeDue, purgeMemory } from "../src/write/forget.ts";
import { save, type WriteEnv } from "../src/write/pipeline.ts";
import { intakePrompt } from "../src/write/prompt.ts";
import { createReview } from "../src/write/rows.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { chatCaller, localCaller, ownerCaller, saveReq, testStore, writeEnv, type TestStore } from "./helpers/store.ts";

const open: TestStore[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));

/** A store whose clock the test can move forward with `later`. */
async function setup(): Promise<{ s: TestStore; env: WriteEnv; later: (ms: number) => void }> {
  const store = await testStore();
  open.push(store);
  let offset = 0;
  const s: TestStore = { ...store, clock: { now: () => store.clock.now() + offset } };
  return { s, env: writeEnv(s), later: (ms) => { offset += ms; } };
}

async function put(env: WriteEnv, caller: Caller, req: SaveRequest): Promise<WriteOutcome> {
  const r = await save(env, caller, req, { idempotencyKey: newId("pxs"), observedAt: env.ctx.clock.now() });
  if (r.kind !== "result") throw new Error("unexpected elicitation");
  return r.outcome;
}

/** A stated memory (T2) holding `word`, forgotten and purged by the owner; returns its id. */
async function purged(env: WriteEnv, s: TestStore, word: string): Promise<string> {
  const content = `Keeps a notebook called ${word}`;
  const id = (await put(env, chatCaller(), saveReq(content, { user_words: `i keep a notebook called ${word.toLowerCase()}` }))).id ?? "";
  forgetByOwner(s, id, 30);
  purgeMemory(s, id, "owner");
  return id;
}

/** Every file in the store's folder that holds `word`, in either case. */
function filesHolding(s: TestStore, word: string): string[] {
  const dir = path.dirname(s.file);
  return readdirSync(dir).filter((f) => {
    const bytes = readFileSync(path.join(dir, f));
    return bytes.includes(Buffer.from(word)) || bytes.includes(Buffer.from(word.toLowerCase()));
  });
}

/** Every text value in `table` that holds `word`. */
function rowsHolding(s: TestStore, table: string, word: string): unknown[] {
  return (s.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
    .filter((r) => Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(word.toLowerCase())));
}

test("purge: every version's text is cleared, the superseded one too; only the hash stays", async () => {
  const { s, env } = await setup();
  const first = await put(env, ownerCaller(), saveReq("Drives a Quillmobile"));
  await put(env, ownerCaller(), saveReq("Drives a Quillmobile Mark Two", { supersedes: first.id, change: "update" }));
  forgetByOwner(s, first.id ?? "", 30);
  purgeMemory(s, first.id ?? "", "owner");
  const versions = s.db.prepare("SELECT content, content_norm_hash FROM memory_version WHERE memory_id = ?").all(first.id ?? "") as { content: string | null; content_norm_hash: string }[];
  expect(versions.length).toBeGreaterThan(0);
  for (const v of versions) {
    expect(v.content).toBeNull();
    expect(v.content_norm_hash).toMatch(/^[0-9a-f]{64}$/u);
  }
});

test("purge: the sources' excerpts and user words are cleared", async () => {
  const { s, env } = await setup();
  const id = await purged(env, s, "Brambleworth");
  expect(rowsHolding(s, "memory_source", "Brambleworth")).toEqual([]);
  expect(s.db.prepare("SELECT count(*) AS n FROM memory_source WHERE memory_id = ? AND (excerpt IS NOT NULL OR user_words IS NOT NULL)").get(id)).toEqual({ n: 0 });
});

test("purge: the embeddings of its versions are deleted", async () => {
  const { s, env } = await setup();
  const id = await purged(env, s, "Corvellian");
  expect(s.db.prepare("SELECT count(*) AS n FROM embedding WHERE owner_type = 'version' AND owner_id IN (SELECT id FROM memory_version WHERE memory_id = ?)").get(id)).toEqual({ n: 0 });
});

test("purge: full-text search no longer finds it, and the FTS shadow tables hold no trace", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Dunmorrow");
  expect(s.db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'dunmorrow'").get()).toEqual({ n: 0 });
  const shadows = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_fts_%'").all() as { name: string }[]).map((t) => t.name);
  expect(shadows.length).toBeGreaterThan(0);
  for (const t of shadows) {
    for (const row of s.db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) {
      for (const v of Object.values(row)) {
        const text = v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v);
        expect(text.toLowerCase().includes("dunmorrow"), t).toBe(false);
      }
    }
  }
});

test("purge: review items that reference it lose their payload", async () => {
  const { s, env } = await setup();
  const id = (await put(env, chatCaller(), saveReq("Keeps a notebook called Elderquay", { user_words: "i keep a notebook called elderquay" }))).id ?? "";
  createReview(s, chatCaller(), { kind: "contested", memoryId: id, observationId: undefined, payload: { content: "Keeps a notebook called Elderquay" } });
  forgetByOwner(s, id, 30);
  purgeMemory(s, id, "owner");
  expect(rowsHolding(s, "review_item", "Elderquay")).toEqual([]);
});

test("purge: an observation promoted into it, and every mention, lose their text and embeddings", async () => {
  const { s, env, later } = await setup();
  const taste = (session: string) => put(env, chatCaller({ sessionKey: session }), saveReq("Likes Fenwhistle tea", { user_words: "i like fenwhistle tea" }));
  await taste("chat:1");
  later(7 * 60 * 60 * 1000); // a later conversation
  const promoted = await taste("chat:2");
  expect(promoted.reason).toBe("recurred");
  forgetByOwner(s, promoted.id ?? "", 30);
  purgeMemory(s, promoted.id ?? "", "owner");
  expect(rowsHolding(s, "observation", "Fenwhistle")).toEqual([]);
  expect(rowsHolding(s, "observation_mention", "Fenwhistle")).toEqual([]);
  expect(s.db.prepare("SELECT count(*) AS n FROM embedding WHERE owner_type = 'observation'").get()).toEqual({ n: 0 });
});

test("purge: an open observation with the same text is purged too", async () => {
  const { s, env } = await setup();
  await put(env, chatCaller(), saveReq("Keeps a notebook called Glimmerdale")); // no user words: an observation
  const id = (await put(env, ownerCaller(), saveReq("Keeps a notebook called Glimmerdale"))).id ?? "";
  forgetByOwner(s, id, 30);
  purgeMemory(s, id, "owner");
  expect(s.db.prepare("SELECT status, content FROM observation").all()).toEqual([{ status: "purged", content: null }]);
});

test("purge: session prompts that contain the text are cleared", async () => {
  const { s, env } = await setup();
  intakePrompt(env, localCaller(), newId("spl"), "Please remember: Keeps a notebook called Hollowmere", "s1", s.clock.now());
  await purged(env, s, "Hollowmere");
  expect(rowsHolding(s, "session_prompt", "Hollowmere")).toEqual([]);
});

test("purge: the text is suppressed, so a model saving it again through MCP is refused", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Ironvale");
  expect(await put(env, chatCaller(), saveReq("Keeps a notebook called Ironvale", { user_words: "i keep a notebook called ironvale" })))
    .toMatchObject({ outcome: "rejected", reason: "previously_forgotten" });
  const suppression = s.db.prepare("SELECT reason, hmac FROM suppression").all() as { reason: string; hmac: string }[];
  expect(suppression.map((x) => x.reason)).toEqual(["purge"]);
  expect(rowsHolding(s, "suppression", "Ironvale")).toEqual([]); // an HMAC, never the text
});

test("purge: a spooled replay of the purged text is refused", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Juniperfell");
  expect(await put(env, localCaller({ channel: "spool_save" }), saveReq("Keeps a notebook called Juniperfell")))
    .toMatchObject({ outcome: "rejected", reason: "previously_forgotten" });
});

test("purge: capture never stages the purged text again", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Kestrelholm");
  expect(await put(env, localCaller({ channel: "capture" }), saveReq("Keeps a notebook called Kestrelholm")))
    .toMatchObject({ outcome: "rejected", reason: "previously_forgotten" });
  expect(rowsHolding(s, "observation", "Kestrelholm")).toEqual([]);
});

test("purge: the event log records ids only", async () => {
  const { s, env } = await setup();
  const id = await purged(env, s, "Larkspurrow");
  const ev = s.db.prepare("SELECT refs_json FROM event WHERE op = 'memory.purge'").get() as { refs_json: string };
  expect(JSON.parse(ev.refs_json)).toEqual({ memory_id: id });
  expect(rowsHolding(s, "event", "Larkspurrow")).toEqual([]);
});

test("purge: the write log, alerts and audit rows hold no text of it", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Mossgrave");
  for (const t of ["write_request", "alert", "audit"]) expect(rowsHolding(s, t, "Mossgrave"), t).toEqual([]);
});

test("purge job (local mode): 30 days after a forget, no file of the store holds the text, the WAL included", async () => {
  const { s, env, later } = await setup();
  const id = (await put(env, chatCaller(), saveReq("Keeps a notebook called Nettlecombe", { user_words: "i keep a notebook called nettlecombe" }))).id ?? "";
  forgetByOwner(s, id, 30);
  later(29 * DAY_MS);
  expect(purgeDue(s, "local")).toEqual([]);
  later(2 * DAY_MS);
  expect(purgeDue(s, "local")).toEqual([id]);
  expect(filesHolding(s, "Nettlecombe")).toEqual([]);
});

test("secure_delete is on: freed pages hold no text after a checkpoint", async () => {
  const { s, env } = await setup();
  expect(s.db.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
  await purged(env, s, "Oakhurst");
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(filesHolding(s, "Oakhurst")).toEqual([]);
});

test("compaction (aws mode's nightly maintenance) leaves no file of the old store with the text", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Pennyfold");
  // As ma-maint does: the server is stopped (its connection closed) before compaction.
  open.pop();
  s.db.close();
  try {
    compactStore(s.file);
    expect(filesHolding(s, "Pennyfold")).toEqual([]);
    expect(readdirSync(path.dirname(s.file)).filter((f) => !/^store\.db(-wal|-shm)?$/u.test(f))).toEqual([]);
  } finally {
    rmSync(path.dirname(s.file), { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a copy is zeroed in place before it is deleted: a second link to its data reads only zeros", async () => {
  const { s } = await setup();
  const copy = path.join(path.dirname(s.file), "pre-migrate-2.db");
  const link = path.join(path.dirname(s.file), "link.db");
  writeFileSync(copy, "Keeps a notebook called Quarrymead".repeat(100));
  linkSync(copy, link);
  zeroAndDelete(copy);
  const left = readFileSync(link);
  expect(left.length).toBeGreaterThan(0);
  expect(left.every((b) => b === 0)).toBe(true);
});

test("an export made after a purge holds no trace of the text", async () => {
  const { s, env } = await setup();
  await purged(env, s, "Rookwater");
  expect(JSON.stringify(storeExport(s, true)).toLowerCase().includes("rookwater")).toBe(false);
});
