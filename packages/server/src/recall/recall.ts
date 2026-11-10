// memory_recall (retrieval.md §2): eleven deterministic steps from a query to rendered notes.
//
//   query check → time → candidates (FTS + vector) → RRF fusion → hard filters → boosts →
//   abstention → read budget → selection (+ contested partners) → rendering → ledger
//
// `recall()` returns the response and a `record` callback; the caller runs `record` after the
// response is sent (step 11), so the ledger never delays the answer.

import { contentWords, norm } from "@memory-anywhere/contracts/normalize";
import { STOPWORDS } from "@memory-anywhere/contracts/policy-data";
import type { RecallInputT, RecallOutputT } from "@memory-anywhere/contracts/schemas/tools";
import type { RecallItemT } from "@memory-anywhere/contracts/schemas/common";
import type { ServerConfigT } from "../config/schema.ts";
import type { Embedder } from "../embed/types.ts";
import { DAY_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { loadRegistry } from "../write/resolve.ts";
import { queryMentions } from "../write/screens.ts";
import { hmacHex } from "../write/suppression.ts";
import { contestPartnerIds, loadCurrent, loadItem, toRecallItem, type ItemRow } from "./items.ts";
import { flagRenderSensitive, newlySensitive } from "./render-check.ts";
import { readBudget, readPolicy, recordReads, repoBlocked, visible, visibleScopes, type Reader } from "./reader.ts";
import { codePointLength, FRAMING, memoryLine } from "./render.ts";
import { readTime, trueAt, overlaps } from "./time.ts";
import type { VectorIndex } from "./vector-index.ts";

export interface ReadEnv {
  readonly ctx: StoreContext;
  readonly config: ServerConfigT;
  readonly embedder: Embedder;
  readonly index: VectorIndex;
}

export const NOTICE = {
  tooBroad: "Query too broad; ask about something specific.",
  noMatch: "No stored memory matches.",
  repoNotEnabled: "memory-anywhere is not enabled for this repository.",
  budget: "The read budget for this app is used up for now.",
} as const;

const CANDIDATES = 50;
const PAST_LIKE_ROWS = 200;
const RRF_K = 60;
const TEXT_BUDGET = 8000;
const TIME_ONLY_LIMIT = 5;
const PARTNER_EXTRA = 2;
const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS);

export interface RecallResult {
  readonly output: RecallOutputT;
  readonly text: string;
  /** Step 11: ledger, recall counters, audit and render-time reviews. Run after the response is sent. */
  record(): void;
}

/** FTS query (retrieval.md §2 step 3): lowercased tokens without stopwords, each quoted, joined with OR. */
export function ftsQuery(text: string): string {
  const tokens = text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "" && !STOPWORD_SET.has(t));
  return [...new Set(tokens)].map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

/** Step 1: at least two content words, or one of at least 4 characters. */
export function specificEnough(query: string): boolean {
  const words = contentWords(query);
  return words.length >= 2 || (words.length === 1 && (words[0] ?? "").length >= 4);
}

interface Candidate {
  readonly versionId: string;
  score: number;
  fromFts: boolean;
  cosine: number;
}

export async function recall(env: ReadEnv, reader: Reader, input: RecallInputT): Promise<RecallResult> {
  const { ctx, config } = env;
  const { db } = ctx;
  const started = ctx.clock.now();
  const policy = readPolicy(db, reader);
  const empty = (notice: string, extra: Partial<RecallOutputT> = {}, ids: readonly string[] = []): RecallResult => ({
    output: { notice, items: [], truncated: false, budget_exhausted: false, offline: false, ...extra },
    text: notice,
    record: () => audit(env, reader, input.query, ids, extra.budget_exhausted ? "budget_exhausted" : "empty", started),
  });

  if (repoBlocked(reader, policy)) return empty(NOTICE.repoNotEnabled);
  if (!specificEnough(input.query)) return empty(NOTICE.tooBroad);

  // 2. Time.
  const time = readTime(input.query, started, config.owner.timezone);
  const includePast = time.includePast || input.as_of !== undefined;
  const limit = time.timeOnly ? Math.min(input.limit, TIME_ONLY_LIMIT) : input.limit;

  // 3–4. Candidates and fusion.
  const fused = new Map<string, Candidate>();
  const add = (versionId: string, rank: number, from: "fts" | "vector", cosine = -1): void => {
    const c = fused.get(versionId) ?? { versionId, score: 0, fromFts: false, cosine: -1 };
    c.score += 1 / (RRF_K + rank);
    if (from === "fts") c.fromFts = true;
    else c.cosine = cosine;
    fused.set(versionId, c);
  };
  ftsCandidates(env, input.query, includePast).forEach((id, i) => add(id, i + 1, "fts"));
  const queryVector = await env.embedder.embedQuery(input.query);
  env.index.search(queryVector, CANDIDATES, includePast).forEach((h, i) => add(h.versionId, i + 1, "vector", h.cosine));

  // 5. Hard filters, one candidate per memory.
  const scopes = visibleScopes(policy, input.scope);
  const section = input.section ? sectionId(env, input.section) : undefined;
  const kinds = input.kinds ? new Set(input.kinds) : undefined;
  const now = iso(started);
  const mentions = (c: Parameters<typeof queryMentions>[0]): boolean => queryMentions(c, input.query);
  const renderHits: string[] = [];
  const passesHard = (row: ItemRow): boolean => {
    if (row.expired) return false;
    const statusOk = row.status === "active" || row.status === "contested" || (includePast && row.status === "superseded");
    if (!statusOk || (!row.current && !includePast)) return false;
    if (row.kind === "event" && row.expiresAt !== null && row.expiresAt <= now && !includePast) return false;
    if (!visible(reader, policy, scopes, row, mentions)) return false;
    if (newlySensitive(row.content, row.sensitivity, config.sensitive.blocked)) {
      renderHits.push(row.memoryId);
      return false;
    }
    return true;
  };
  const narrows = (row: ItemRow): boolean =>
    (section === undefined || row.sectionId === section) &&
    (kinds === undefined || kinds.has(row.kind)) &&
    (input.as_of === undefined || trueAt(row.validFrom, row.validTo, input.as_of)) &&
    (time.range === undefined || overlaps(row.validFrom, row.validTo, time.range));

  // One item per memory; with history included, one per version, so "Works at Acme until …"
  // can appear next to the current value of the same memory.
  const itemKey = (row: ItemRow): string => (includePast ? row.versionId : row.memoryId);
  const best = new Map<string, { row: ItemRow; c: Candidate }>();
  for (const c of fused.values()) {
    const row = loadItem(db, c.versionId);
    if (!row || !passesHard(row) || !narrows(row)) continue;
    // 6. Boosts.
    const ageDays = Math.max(0, (started - Date.parse(row.recordedAt)) / DAY_MS);
    c.score += (row.pinned ? 0.01 : 0) + (row.tier === 0 ? 0.005 : row.tier === 1 ? 0.003 : 0) + 0.004 * Math.exp(-ageDays / 180);
    const prev = best.get(itemKey(row));
    if (!prev || c.score > prev.c.score) best.set(itemKey(row), { row, c });
  }
  const ranked = [...best.values()].sort((a, b) => b.c.score - a.c.score || (a.row.versionId < b.row.versionId ? -1 : 1));

  // 7. Abstention.
  const anyFts = ranked.some((r) => r.c.fromFts);
  const bestCosine = Math.max(-1, ...ranked.map((r) => r.c.cosine));
  if (ranked.length === 0 || (!anyFts && bestCosine < abstainCosine(env))) return { ...empty(NOTICE.noMatch), record: () => recordRender(env, reader, renderHits, input.query, [], started) };

  // 8–9. Read budget, selection, contested partners.
  const budget = readBudget(db, reader.clientId, policy, started);
  const selected: { row: ItemRow; partners: string[] }[] = [];
  const taken = new Set<string>();
  let extra = 0;
  for (const { row } of ranked) {
    if (selected.length - extra >= limit) break;
    if (taken.has(itemKey(row)) || !budget.admit(row.memoryId)) continue;
    const partners = row.status === "contested" ? visiblePartners(env, row.memoryId, passesHard) : [];
    selected.push({ row, partners: partners.map((p) => p.memoryId) });
    taken.add(itemKey(row));
    for (const p of partners) {
      if (taken.has(itemKey(p)) || extra >= PARTNER_EXTRA || !budget.admit(p.memoryId)) continue;
      selected.push({ row: p, partners: visiblePartners(env, p.memoryId, passesHard).map((q) => q.memoryId) });
      taken.add(itemKey(p));
      extra++;
    }
  }
  if (selected.length === 0) return empty(NOTICE.budget, { budget_exhausted: true });

  // 10. Render whole items within the text budget.
  const items: RecallItemT[] = [];
  const lines = [FRAMING];
  let used = codePointLength(FRAMING);
  let truncated = false;
  for (const s of selected) {
    const item = toRecallItem(s.row, s.partners);
    const line = memoryLine(item);
    if (used + 1 + codePointLength(line) > TEXT_BUDGET) {
      truncated = true;
      break;
    }
    items.push(item);
    lines.push(line);
    used += 1 + codePointLength(line);
  }
  const ids = items.map((i) => i.id);
  return {
    output: { notice: FRAMING, items, truncated, budget_exhausted: false, offline: false, generated_at: iso(started) },
    text: lines.join("\n"),
    record: () => recordRender(env, reader, renderHits, input.query, ids, started),
  };
}

/** FTS ranks: current versions by bm25, then (when the past is included) older versions matching by LIKE. */
function ftsCandidates(env: ReadEnv, query: string, includePast: boolean): string[] {
  const q = ftsQuery(query);
  if (q === "") return [];
  const { db } = env.ctx;
  const current = (prepared(db, "SELECT version_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts, 0, 1.0, 0.5, 0.5), version_id LIMIT ?")
    .all(q, CANDIDATES) as { version_id: string }[]).map((r) => r.version_id);
  if (!includePast) return current;
  const tokens = [...new Set(contentWords(query))].slice(0, 8);
  if (tokens.length === 0) return current;
  const like = tokens.map(() => "lower(v.content) LIKE ? ESCAPE '\\'").join(" + ");
  const past = (prepared(db, 
    `SELECT v.id, (${like}) AS hits FROM memory_version v
     WHERE v.content IS NOT NULL AND (v.valid_to IS NOT NULL OR v.expired_at IS NOT NULL) AND (${like}) > 0
     ORDER BY hits DESC, v.recorded_at DESC, v.id LIMIT ?`,
  ).all(...tokens.map(likePattern), ...tokens.map(likePattern), PAST_LIKE_ROWS) as { id: string }[]).map((r) => r.id);
  return [...current, ...past];
}

const likePattern = (t: string): string => `%${t.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

function sectionId(env: ReadEnv, name: string): string {
  return loadRegistry(env.ctx.db).sections.find((s) => s.keys.includes(norm(name)))?.id ?? "sec_none";
}

function abstainCosine(env: ReadEnv): number {
  const v = prepared(env.ctx.db, "SELECT value FROM meta WHERE key = 'abstain_cosine'").get() as { value: string } | undefined;
  return Number(v?.value ?? "0.30");
}

/** A contested memory's partners that the caller may see, by their current versions. */
function visiblePartners(env: ReadEnv, memoryId: string, passes: (row: ItemRow) => boolean): ItemRow[] {
  return contestPartnerIds(env.ctx.db, memoryId)
    .map((id) => loadCurrent(env.ctx.db, id))
    .filter((r): r is ItemRow => r !== undefined && passes(r));
}

function recordRender(env: ReadEnv, reader: Reader, renderHits: readonly string[], query: string, ids: readonly string[], started: number): void {
  const { ctx } = env;
  transaction(ctx.db, () => {
    recordReads(ctx.db, reader.clientId, ids, ctx.clock.now(), true);
    flagRenderSensitive(ctx, reader, renderHits);
  });
  audit(env, reader, query, ids, ids.length > 0 ? "ok" : "empty", started);
}

/** An audit row: the query only as an HMAC, and the returned ids (data-model.md §2). */
export function audit(env: ReadEnv, reader: Reader, query: string, ids: readonly string[], outcome: string, started: number): void {
  const { ctx } = env;
  const key = (prepared(ctx.db, "SELECT value FROM meta WHERE key = 'audit_hmac_key'").get() as { value: string }).value;
  const now = ctx.clock.now();
  prepared(ctx.db, "INSERT INTO audit (id, at, client_id, op, query_hmac, result_ids, outcome, status_code, ip_prefix, latency_ms) VALUES (?, ?, ?, 'memory_recall', ?, ?, ?, NULL, NULL, ?)")
    .run(ctx.ids.newId("aud", now), iso(now), reader.clientId, hmacHex(key, norm(query)), JSON.stringify(ids), outcome, Math.max(0, now - started));
}
