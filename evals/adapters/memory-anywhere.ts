// memory-anywhere as a suite R system (evals.md §3.2; spec-issues #26). For each LongMemEval
// question a fresh in-memory store is seeded with the question's haystack, one memory per round,
// straight into the real retrieval index: a version row (recorded at the session's date), its FTS
// row and its embedding. The query then runs through the server's own ranking (retrieval.md §2
// steps 1–7: candidates, RRF fusion, filters, boosts, abstention) at the question's date.
//
// Rounds are far longer than the 400-character save limit, which is why they are seeded rather
// than saved, and why the ranking is scored before the 8,000-character render step.
//
// Suite R measures ranking, so the sensitive lexicons are off here (owner decision, spec-issues
// #47): conversation rounds often mention health or money, and the render-time check would
// withhold them. That policy is gated by suite P instead.

import type { DatabaseSync } from "node:sqlite";
import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import { activeModel, type PinnedModel } from "../../packages/server/src/embed/manifest.ts";
import type { Embedder } from "../../packages/server/src/embed/types.ts";
import { rank } from "../../packages/server/src/recall/recall.ts";
import { VectorIndex } from "../../packages/server/src/recall/vector-index.ts";
import { iso, steppingClock } from "../../packages/server/src/store/clock.ts";
import { openStore } from "../../packages/server/src/store/db.ts";
import { initStore } from "../../packages/server/src/store/init.ts";
import { migrate } from "../../packages/server/src/store/migrate.ts";
import type { Doc } from "../harness/lme.ts";

export const EVAL_CLIENT = "cli_eval";

/** "2023/05/20 (Sat) 02:21" → epoch ms (LongMemEval's date format), taken as UTC. */
export function lmeDate(s: string): number {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?: \(\w+\))?(?: (\d{2}):(\d{2}))?/u.exec(s);
  if (!m) throw new Error(`unrecognised LongMemEval date ${s}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

export interface SeededDoc extends Doc {
  /** When the round was said (the session's date). */
  readonly at: number;
  readonly vector: Float32Array;
}

/** A fresh store holding the haystack; returns it with the version id of each document. */
export async function seedStore(model: PinnedModel, docs: readonly SeededDoc[]): Promise<{ db: DatabaseSync; versionToDoc: Map<string, string> }> {
  const db = openStore(":memory:", { mode: "local" });
  await migrate(db, undefined);
  const ids = idSource(seededPrng(7));
  const ctx = { db, clock: { now: () => Date.UTC(2020, 0, 1) }, ids };
  initStore(ctx, {
    embedding: { modelId: model.modelId, dim: model.dims, queryPrefix: model.query_prefix, docPrefix: model.document_prefix, filesSha256: {} },
    localClient: undefined,
  });
  db.prepare(`INSERT INTO client_policy (client_id, display_name, vendor, class, read, write, section_allow_json, read_budget_1h, read_budget_24h, created_at)
    VALUES (?, 'eval', 'eval', 'chat', 1, 0, '["*"]', 1000000, 1000000, '2020-01-01T00:00:00.000Z')`).run(EVAL_CLIENT);
  const memory = db.prepare(`INSERT INTO memory (id, entity_id, section_id, kind, scope, status, created_at, updated_at, created_by_client_id)
    VALUES (?, 'ent_self', 'sec_unsorted', 'fact', 'global', 'active', ?, ?, ?)`);
  const version = db.prepare(`INSERT INTO memory_version (id, memory_id, content, content_norm_hash, valid_from, valid_from_precision, recorded_at, trust_tier, tier_basis, extraction_method, change_kind, client_id)
    VALUES (?, ?, ?, ?, ?, 'day', ?, 2, 'model', 'import', 'initial', ?)`);
  const fts = db.prepare("INSERT INTO memory_fts (version_id, content, excerpts, aliases) VALUES (?, ?, '', '')");
  const vec = db.prepare("INSERT INTO embedding (owner_type, owner_id, model_id, dim, vector) VALUES ('version', ?, ?, ?, ?)");
  const versionToDoc = new Map<string, string>();
  db.exec("BEGIN");
  for (const d of docs) {
    const at = iso(d.at);
    const memoryId = ids.newId("mem", d.at);
    const versionId = ids.newId("ver", d.at);
    memory.run(memoryId, at, at, EVAL_CLIENT);
    version.run(versionId, memoryId, d.text, contentNormHash(d.text), at.slice(0, 10), at, EVAL_CLIENT);
    fts.run(versionId, d.text);
    vec.run(versionId, model.modelId, d.vector.length, new Uint8Array(d.vector.buffer, d.vector.byteOffset, d.vector.byteLength));
    versionToDoc.set(versionId, d.id);
  }
  db.exec("COMMIT");
  return { db, versionToDoc };
}

/** Ranked document ids for one question, by the server's ranking at the question's date. */
export async function memoryAnywhereRank(embedder: Embedder, docs: readonly SeededDoc[], query: string, questionAt: number, model: PinnedModel = activeModel()): Promise<string[]> {
  const { db, versionToDoc } = await seedStore(model, docs);
  try {
    const config = { ...defaultConfig(), sensitive: { blocked: [], llm_check: false } };
    const env = { ctx: { db, clock: steppingClock(questionAt, 0), ids: idSource(seededPrng(9)) }, config, embedder, index: VectorIndex.load(db, model.modelId) };
    const r = await rank(env, { clientId: EVAL_CLIENT, clientClass: "chat", repoKey: undefined, admin: false }, { query, scope: "any", limit: 10 });
    return r.kind === "ranked" ? r.ranked.map((x) => versionToDoc.get(x.row.versionId) ?? "").filter(Boolean) : [];
  } finally {
    db.close();
  }
}
