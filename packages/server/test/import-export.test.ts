// Moving a full export into an empty store (deployment-aws.md §5.6, data-model.md §10): the
// one-time key, the verbatim copy, rebuilt embeddings and search, and every refusal.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId } from "@memory-anywhere/contracts/ids";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Alerts } from "../src/ops/alerts.ts";
import { encryptTo, storeExport } from "../src/ops/export.ts";
import { importTransfer, prepareTransferKey } from "../src/ops/import-export.ts";
import { NO_OUTBOX } from "../src/ops/outbox.ts";
import { HOUR_MS } from "../src/store/clock.ts";
import { canonicalDump } from "../src/store/dump.ts";
import { save } from "../src/write/pipeline.ts";
import { chatCaller, fakeEmbedder, ownerCaller, saveReq, testStore, writeEnv, type TestStore } from "./helpers/store.ts";

let dir: string;
let source: TestStore;
let target: TestStore;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ma import "));
  source = await testStore({ memory: true, seed: 3 });
  target = await testStore({ memory: true, seed: 4 });
});
afterEach(() => {
  source.close();
  target.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function fill(s: TestStore): Promise<void> {
  const env = writeEnv(s);
  for (const c of ["Lives in Lisbon", "Prefers short answers", "Works at Acme as a designer"]) {
    await save(env, ownerCaller(), saveReq(c), { idempotencyKey: newId("adm"), observedAt: s.clock.now() });
  }
  await save(env, chatCaller(), saveReq("Likes jazz", { user_words: "i like jazz" }), { idempotencyKey: newId("adm"), observedAt: s.clock.now() });
}

/** The PC's step: the export, re-encrypted for the one-time recipient, saved in the drop folder. */
async function transfer(s: TestStore, includeAuth = false): Promise<{ keyDir: string; file: string }> {
  const keyDir = path.join(dir, "inbox key");
  const recipient = await prepareTransferKey(keyDir, target.clock.now());
  const file = path.join(dir, "drop", "export.transfer.age");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await encryptTo(recipient, new TextEncoder().encode(JSON.stringify(storeExport(s, includeAuth)))));
  return { keyDir, file };
}

const content = (s: TestStore) => canonicalDump(s.db).filter((l) => !/"table":"(meta|alert)"/u.test(l));

test("an empty store receives the export verbatim, with embeddings and search rebuilt; file and key are gone", async () => {
  await fill(source);
  const t = await transfer(source);
  const alerts = new Alerts(target, NO_OUTBOX);
  const r = await importTransfer({ ctx: target, embedder: fakeEmbedder, alerts, keyDir: t.keyDir, file: t.file, includeAuth: false });
  const memories = (source.db.prepare("SELECT count(*) AS n FROM memory").get() as { n: number }).n;
  expect(memories).toBe(3); // the single mention of a taste stays an observation
  expect(r).toMatchObject({ kind: "full", memories, observations: 1 });
  expect(content(target)).toEqual(content(source));
  const hmac = (s: TestStore) => s.db.prepare("SELECT value FROM meta WHERE key = 'store_hmac_key'").get();
  expect(hmac(target)).toEqual(hmac(source)); // suppressions keep matching
  const n = (s: TestStore, sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
  expect(n(target, "SELECT count(*) AS n FROM embedding WHERE owner_type = 'version'")).toBe(n(source, "SELECT count(*) AS n FROM embedding WHERE owner_type = 'version'"));
  expect(n(target, "SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'lisbon'")).toBe(1);
  expect(alerts.open().map((a) => a.kind)).toContain("store_imported");
  expect(existsSync(t.file)).toBe(false);
  expect(existsSync(path.join(t.keyDir, "transfer.json"))).toBe(false);
});

test("a store that already holds memories is refused and unchanged; so is an expired key, and the file is still destroyed", async () => {
  await fill(source);
  await fill(target);
  const before = content(target);
  const t = await transfer(source);
  const alerts = new Alerts(target, NO_OUTBOX);
  await expect(importTransfer({ ctx: target, embedder: fakeEmbedder, alerts, keyDir: t.keyDir, file: t.file, includeAuth: false })).rejects.toThrow(/already holds memories/u);
  expect(content(target)).toEqual(before);
  expect(existsSync(t.file)).toBe(false);

  const empty = await testStore({ memory: true, seed: 5 });
  try {
    const late = await transfer(source);
    const lateCtx = { ...empty, clock: { now: () => target.clock.now() + HOUR_MS + 1 } };
    await expect(importTransfer({ ctx: lateCtx, embedder: fakeEmbedder, alerts: new Alerts(lateCtx, NO_OUTBOX), keyDir: late.keyDir, file: late.file, includeAuth: false }))
      .rejects.toThrow(/older than an hour/u);
    expect(existsSync(late.file)).toBe(false);
  } finally {
    empty.close();
  }
});

test("--include-auth needs an export made with it, and another embedding model is refused", async () => {
  await fill(source);
  const plain = await transfer(source, false);
  const alerts = new Alerts(target, NO_OUTBOX);
  await expect(importTransfer({ ctx: target, embedder: fakeEmbedder, alerts, keyDir: plain.keyDir, file: plain.file, includeAuth: true })).rejects.toThrow(/made with --include-auth/u);
  source.db.prepare("UPDATE meta SET value = 'other-model' WHERE key = 'embedding_model_id'").run();
  const other = await transfer(source, false);
  await expect(importTransfer({ ctx: target, embedder: fakeEmbedder, alerts, keyDir: other.keyDir, file: other.file, includeAuth: false })).rejects.toThrow(/embedding_model_id/u);
});
