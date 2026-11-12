// Suite P, server stage (evals.md §3.3): every proposal goes through the real write pipeline on a
// fresh in-memory store, as a chat app at T2, and the stored outcome is compared with the label.
//
// The gates: 0/n secrets stored, and 0/n sensitive memories stored active without a verified
// request, n ≥ 100 each, reported with the one-sided 95% upper bound. The other families are
// reported per row with Wilson intervals.

import { createHash } from "node:crypto";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { contentWords } from "@memory-anywhere/contracts/normalize";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import type { Embedder } from "../../packages/server/src/embed/types.ts";
import { steppingClock } from "../../packages/server/src/store/clock.ts";
import { openStore } from "../../packages/server/src/store/db.ts";
import { initStore } from "../../packages/server/src/store/init.ts";
import { migrate } from "../../packages/server/src/store/migrate.ts";
import { save } from "../../packages/server/src/write/pipeline.ts";
import type { Caller } from "../../packages/server/src/write/types.ts";
import { buildProposals, type Proposal } from "../datasets/p/build.ts";
import { wilson } from "./stats.ts";

/**
 * A deterministic bag-of-words embedder. Server-stage decisions come from the screens and the
 * decision table; embeddings only matter for duplicates, which these proposals do not contain.
 */
const DIM = 256;
export const bowEmbedder: Embedder = {
  modelId: "eval-bow@1",
  dim: DIM,
  embedDocuments: async (texts) => texts.map(bow),
  embedQuery: async (text) => bow(text),
};
function bow(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const w of contentWords(text)) {
    const b = (createHash("sha256").update(w).digest()[0] ?? 0) % DIM;
    v[b] = (v[b] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const CLIENT = "cli_eval_chat";
const caller: Caller = {
  clientId: CLIENT, clientClass: "chat", channel: "mcp", tier: 2, sessionKey: `${CLIENT}:1`, repoKey: undefined, tool: "eval",
  floored: false, canElicit: false, elicitationAnswer: undefined,
};

export interface ProposalResult {
  readonly id: string;
  readonly family: string;
  readonly expected: Proposal["expected"];
  readonly outcome: string;
  readonly reason: string;
  /** A memory row exists with status active or contested. */
  readonly storedActive: boolean;
}

export async function runProposal(p: Proposal): Promise<ProposalResult> {
  const db = openStore(":memory:", { mode: "local" });
  try {
    await migrate(db, undefined);
    const ctx = { db, clock: steppingClock(Date.parse("2026-11-10T12:00:00.000Z")), ids: idSource(seededPrng(3)) };
    initStore(ctx, { embedding: { modelId: bowEmbedder.modelId, dim: DIM, queryPrefix: "", docPrefix: "", filesSha256: {} }, localClient: undefined });
    db.prepare(`INSERT INTO client_policy (client_id, display_name, vendor, class, read, write, section_allow_json, quota_saves_per_hour, created_at)
      VALUES (?, 'eval chat', 'eval', 'chat', 1, 1, '["*"]', 1000, '2026-11-10T00:00:00.000Z')`).run(CLIENT);
    const r = await save({ ctx, config: defaultConfig(), embedder: bowEmbedder }, caller, { explicit_request: false, entity: "self", scope: "global", change: "update", ...p.save },
      { idempotencyKey: `pxs_${idSource(seededPrng(5)).newUlid(ctx.clock.now())}`, observedAt: ctx.clock.now() });
    const outcome = r.kind === "result" ? r.outcome : { outcome: "elicit", reason: "elicit" };
    const active = (db.prepare("SELECT count(*) AS n FROM memory WHERE status IN ('active','contested')").get() as { n: number }).n > 0;
    return { id: p.id, family: p.family, expected: p.expected, outcome: outcome.outcome, reason: outcome.reason, storedActive: active };
  } finally {
    db.close();
  }
}

/** One-sided 95% upper bound for k = 0 of n (exact): 1 − 0.05^(1/n). */
export const zeroUpperBound = (n: number): number => 1 - 0.05 ** (1 / n);

export interface SuitePResult {
  readonly suite: "P";
  readonly stage: "server";
  readonly system: "memory-anywhere";
  readonly dataset: string;
  readonly policy_version: "P1";
  readonly n: number;
  readonly gates: Record<"secrets" | "sensitive", { stored: number; n: number; upper95: number; pass: boolean }>;
  readonly families: Record<string, { n: number; labels: Proposal["labels"]; correct: number; accuracy: { mean: number; ci95: [number, number] } }>;
  readonly mismatches: readonly ProposalResult[];
}

export async function runSuiteP(): Promise<SuitePResult> {
  const proposals = buildProposals();
  const results: ProposalResult[] = [];
  for (const p of proposals) results.push(await runProposal(p));
  const gate = (prefix: string): SuitePResult["gates"]["secrets"] => {
    const rows = results.filter((r) => r.family.startsWith(prefix));
    const stored = rows.filter((r) => r.storedActive).length;
    return { stored, n: rows.length, upper95: zeroUpperBound(rows.length), pass: stored === 0 && rows.length >= 100 };
  };
  const families: SuitePResult["families"] = {};
  for (const fam of [...new Set(results.map((r) => r.family.split(":")[0] ?? r.family))]) {
    const rows = results.filter((r) => (r.family.split(":")[0] ?? r.family) === fam);
    const correct = rows.filter((r) => r.outcome === r.expected.outcome && r.reason === r.expected.reason).length;
    const w = wilson(correct, rows.length);
    families[fam] = { n: rows.length, labels: proposals.find((p) => p.family.startsWith(fam))?.labels ?? "author", correct, accuracy: { mean: correct / rows.length, ci95: w.ci95 } };
  }
  return {
    suite: "P", stage: "server", system: "memory-anywhere", dataset: `p-server-${results.length}`, policy_version: "P1", n: results.length,
    gates: { secrets: gate("secret"), sensitive: gate("sensitive") },
    families,
    mismatches: results.filter((r) => r.outcome !== r.expected.outcome || r.reason !== r.expected.reason),
  };
}
