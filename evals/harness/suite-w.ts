// Suite W (evals.md §3.1): each case saves its prior facts and then its input through the real
// write pipeline on a fresh store, and the operation is read back from the store, not from the
// reply:
//
//   prior version closed (valid_to)        → update        prior version expired, new text kept → correction
//   prior memory gained a source only      → dup           a new memory                         → new / contested
//   an observation                         → observation   a held memory                        → review
//   nothing stored                         → reject
//
// The gate counts wrong supersedes: a prior version closed or expired when the expected op was not
// a supersede. A case is supersede-eligible when its expected op is not a supersede and its prior
// was stored, so a supersede was possible.
//
// With an LLM provider (`--llm fake-adversarial`), the product's slot proposal and sensitive check
// run too, through the real adapter, so the gate also covers slots the LLM chose.

import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import { Llm, type LlmProvider } from "../../packages/server/src/llm/adapter.ts";
import type { Embedder } from "../../packages/server/src/embed/types.ts";
import { steppingClock } from "../../packages/server/src/store/clock.ts";
import { openStore } from "../../packages/server/src/store/db.ts";
import { initStore } from "../../packages/server/src/store/init.ts";
import { migrate } from "../../packages/server/src/store/migrate.ts";
import { save } from "../../packages/server/src/write/pipeline.ts";
import type { Caller } from "../../packages/server/src/write/types.ts";
import type { WCase, WOp } from "../datasets/w/build.ts";
import { wilson } from "./stats.ts";
import { zeroUpperBound } from "./suite-p.ts";

const CLIENT = "cli_eval_chat";
const caller: Caller = {
  clientId: CLIENT, clientClass: "chat", channel: "mcp", tier: 2, sessionKey: `${CLIENT}:1`, repoKey: undefined, tool: "eval",
  floored: false, canElicit: false, elicitationAnswer: undefined,
};
const SUPERSEDES: ReadonlySet<WOp> = new Set(["update", "correction"]);

export interface WResult {
  readonly case_id: string;
  readonly split: WCase["split"];
  readonly expected: WOp;
  readonly observed: WOp;
  readonly priorStored: boolean;
  readonly eligible: boolean;
  readonly wrongSupersede: boolean;
}

export async function runCase(c: WCase, embedder: Embedder, llmProvider?: LlmProvider): Promise<WResult> {
  const db = openStore(":memory:", { mode: "local" });
  try {
    await migrate(db, undefined);
    const ctx = { db, clock: steppingClock(Date.parse("2026-11-10T12:00:00.000Z"), 60_000), ids: idSource(seededPrng(11)) };
    initStore(ctx, { embedding: { modelId: embedder.modelId, dim: embedder.dim, queryPrefix: "", docPrefix: "", filesSha256: {} }, localClient: undefined });
    db.prepare(`INSERT INTO client_policy (client_id, display_name, vendor, class, read, write, section_allow_json, quota_saves_per_hour, created_at)
      VALUES (?, 'eval chat', 'eval', 'chat', 1, 1, '["*"]', 1000, '2026-11-10T00:00:00.000Z')`).run(CLIENT);
    const base = defaultConfig();
    const config = llmProvider ? { ...base, llm: { ...base.llm, provider: "anthropic" as const } } : base;
    const env = { ctx, config, embedder, ...(llmProvider ? { llm: new Llm({ ctx, config, provider: llmProvider }) } : {}) };
    const put = (fact: { entity: string; content: string }, n: number) =>
      save(env, caller, { content: fact.content, kind: "fact", why_durable: "a lasting fact", user_words: fact.content.toLowerCase(), explicit_request: false, entity: fact.entity, scope: "global", change: "update" },
        { idempotencyKey: `pxs_01JC9Z3N4V8Q2W5X7Y9Z0A1B${String(n).padStart(2, "0")}`, observedAt: ctx.clock.now() });

    for (const [n, p] of c.prior.entries()) await put(p, n);
    const priorIds = (db.prepare("SELECT id FROM memory WHERE status IN ('active','contested')").all() as { id: string }[]).map((r) => r.id);
    const count = (sql: string, ...p: string[]): number => (db.prepare(sql).get(...p) as { n: number }).n;
    const before = { memories: count("SELECT count(*) AS n FROM memory"), sources: count("SELECT count(*) AS n FROM memory_source"), observations: count("SELECT count(*) AS n FROM observation") };

    await put(c.input, 99);

    const closed = priorIds.some((id) => count("SELECT count(*) AS n FROM memory_version WHERE memory_id = ? AND valid_to IS NOT NULL", id) > 0);
    const expired = priorIds.some((id) => count("SELECT count(*) AS n FROM memory_version WHERE memory_id = ? AND expired_at IS NOT NULL", id) > 0);
    const newMemories = db.prepare("SELECT status FROM memory ORDER BY created_at DESC, id DESC LIMIT ?").all(count("SELECT count(*) AS n FROM memory") - before.memories) as { status: string }[];
    const observed: WOp =
      closed ? "update"
      : expired ? "correction"
      : newMemories.some((m) => m.status === "contested") ? "contested"
      : newMemories.some((m) => m.status === "pending_review") ? "review"
      : newMemories.some((m) => m.status === "superseded") ? "historical"
      : newMemories.length > 0 ? "new"
      : count("SELECT count(*) AS n FROM observation") > before.observations ? "observation"
      : count("SELECT count(*) AS n FROM memory_source") > before.sources ? "dup"
      : "reject";
    const priorStored = priorIds.length > 0;
    const eligible = !SUPERSEDES.has(c.expected.op) && priorStored;
    return { case_id: c.case_id, split: c.split, expected: c.expected.op, observed, priorStored, eligible, wrongSupersede: eligible && SUPERSEDES.has(observed) };
  } finally {
    db.close();
  }
}

export interface SuiteWResult {
  readonly suite: "W";
  readonly system: "memory-anywhere";
  readonly dataset: string;
  readonly split: WCase["split"];
  /** The LLM behind the write path: none, or the scripted adversary (no key, no network). */
  readonly llm: "none" | "fake-adversarial";
  readonly labels: "public";
  readonly n: number;
  readonly gate: { eligible: number; wrong_supersedes: number; upper95: number; pass: boolean };
  readonly confusion: Record<string, Record<string, number>>;
  readonly accuracy: { k: number; n: number; ci95: [number, number] };
}

export async function runSuiteW(cases: readonly WCase[], embedder: Embedder, split: WCase["split"], llm?: { name: "fake-adversarial"; provider: LlmProvider }): Promise<{ result: SuiteWResult; rows: WResult[] }> {
  const rows: WResult[] = [];
  for (const c of cases.filter((x) => x.split === split)) rows.push(await runCase(c, embedder, llm?.provider));
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const row = (confusion[r.expected] ??= {});
    row[r.observed] = (row[r.observed] ?? 0) + 1;
  }
  const eligible = rows.filter((r) => r.eligible).length;
  const wrong = rows.filter((r) => r.wrongSupersede).length;
  const correct = rows.filter((r) => r.observed === r.expected).length;
  return {
    rows,
    result: {
      suite: "W", system: "memory-anywhere", dataset: `w-factconsolidation-${cases.length}`, split, llm: llm?.name ?? "none", labels: "public", n: rows.length,
      gate: { eligible, wrong_supersedes: wrong, upper95: zeroUpperBound(eligible), pass: wrong === 0 && eligible >= 100 && rows.length >= 150 },
      confusion,
      accuracy: { k: correct, n: rows.length, ci95: wilson(correct, rows.length).ci95 },
    },
  };
}
