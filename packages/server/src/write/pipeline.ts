// The write pipeline (write-path.md §1): one entry point for every save, whatever the channel.
//   pre-checks → idempotency → verify → resolve → screens → decision table → embedding (outside the
//   transaction) → one transaction: store rules or observation or review, FTS, events, write_request.
// Saves from tools, spool replays and capture all come through `save()`; forgets through `forget()`.

import { createHash } from "node:crypto";
import { norm } from "@memory-anywhere/contracts/normalize";
import { reasonMessage, USER_WORDS_NOT_FOUND_SUFFIX, type ReasonCode } from "@memory-anywhere/contracts/reasons";
import type { ServerConfigT } from "../config/schema.ts";
import type { Embedder } from "../embed/types.ts";
import { POLICY_VERSION } from "../policy/generated.ts";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { transaction, prepared } from "../store/db.ts";
import { decide, type DecideInput } from "./decide.ts";
import { forgetByClient, type ForgetResult } from "./forget.ts";
import { addMention } from "./observations.ts";
import { loadRegistry, resolve } from "./resolve.ts";
import { createReview, insertSource, linkSource, periodStart, refreshFts, currentVersion } from "./rows.ts";
import { instructionHit, secretHit, sensitiveCategory, shortLivedHit } from "./screens.ts";
import { applyStoreRules, storeForReview, type StoreResult } from "./store-rules.ts";
import { isSuppressed, liftMatching } from "./suppression.ts";
import { tierLabel, WriteError, type Caller, type SaveRequest, type TierNum, type WriteOutcome } from "./types.ts";
import { verify } from "./verify.ts";

export interface WriteEnv {
  readonly ctx: StoreContext;
  readonly config: ServerConfigT;
  readonly embedder: Embedder;
  /** Called after each commit with the memories whose search entries changed. */
  readonly onCommit?: (touchedMemoryIds: readonly string[]) => void;
}

export interface RequestMeta {
  readonly idempotencyKey: string;
  /** When the user said it: receipt time for live calls, `spooled_at` for replays. */
  readonly observedAt: number;
}

export type SaveResult =
  | { readonly kind: "result"; readonly outcome: WriteOutcome }
  | { readonly kind: "input_required"; readonly question: string };

/** Idempotency key for MCP saves from clients without their own key (write-path.md §2.3). */
export function mcpIdempotencyKey(clientId: string, req: SaveRequest, contentHash: string, nowMs: number): string {
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const fields = [
    clientId, contentHash, req.kind, req.user_words === undefined ? "" : sha(norm(req.user_words)), String(req.explicit_request), req.supersedes ?? "",
    String(Math.floor(nowMs / 1000 / 21_600)),
  ];
  return sha(fields.join("\n"));
}

function meta(ctx: StoreContext, key: string): string {
  return (prepared(ctx.db, "SELECT value FROM meta WHERE key = ?").get(key) as { value: string }).value;
}

function storedResult(ctx: StoreContext, key: string): WriteOutcome | undefined {
  const row = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(key) as { result_json: string } | undefined;
  return row ? (JSON.parse(row.result_json) as WriteOutcome) : undefined;
}

function recordRequest(env: WriteEnv, caller: Caller, op: "save" | "forget" | "prompt" | "capture" | "admin", m: RequestMeta, outcome: { outcome: string; reason: string }, result: unknown): void {
  const now = env.ctx.clock.now();
  prepared(env.ctx.db, 
      `INSERT INTO write_request (idempotency_key, client_id, op, received_at, observed_at, outcome, reason, result_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.idempotencyKey, caller.clientId, op, iso(now), iso(m.observedAt), outcome.outcome, outcome.reason, JSON.stringify(result),
      iso(now + env.config.retention.write_request_days * DAY_MS));
}

function sectionName(ctx: StoreContext, id: string): string {
  return (prepared(ctx.db, "SELECT name FROM section WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "Unsorted";
}

/** Pre-checks that are errors, not outcomes (write-path.md §5): client, repo, quota. */
function preChecks(env: WriteEnv, caller: Caller, op: "save" | "forget"): void {
  if (caller.channel === "admin" || caller.channel === "review_approve" || caller.channel === "capture") return;
  const client = prepared(env.ctx.db, "SELECT write, revoked_at, quota_saves_per_hour FROM client_policy WHERE client_id = ?").get(caller.clientId) as
    | { write: number; revoked_at: string | null; quota_saves_per_hour: number }
    | undefined;
  if (!client || client.revoked_at) throw new WriteError("FORBIDDEN", "this app's access was revoked");
  if (client.write !== 1) throw new WriteError("READ_ONLY_CLIENT", "this app may read memories but not change them");
  if (caller.clientClass === "coding") {
    const repo = prepared(env.ctx.db, "SELECT enabled FROM repo WHERE repo_key = ?").get(caller.repoKey ?? "none") as { enabled: number } | undefined;
    if (!repo || repo.enabled !== 1) throw new WriteError("REPO_NOT_ENABLED", "Run `mema enable` in this repository to use memory here.");
  }
  if (op === "save") {
    const since = iso(env.ctx.clock.now() - HOUR_MS);
    const n = (prepared(env.ctx.db, "SELECT count(*) n FROM write_request WHERE client_id = ? AND op = 'save' AND received_at > ?").get(caller.clientId, since) as { n: number }).n;
    if (n >= client.quota_saves_per_hour) throw new WriteError("RATE_LIMITED", "hourly save limit reached", undefined, 3600);
  }
}

/**
 * Waits up to 1.5 s for a session prompt that contains the user's words (write-path.md §4 step 5).
 * Only a coding tool's own saves are checked, and only in an enabled repo, where its prompts are
 * logged; the owner's admin and review channels and the capture job are not tool calls.
 */
function promptFinder(env: WriteEnv, caller: Caller): ((u: string) => Promise<boolean>) | undefined {
  if (caller.clientClass !== "coding" || (caller.channel !== "mcp" && caller.channel !== "spool_save")) return undefined;
  const repo = caller.repoKey ? (prepared(env.ctx.db, "SELECT enabled FROM repo WHERE repo_key = ?").get(caller.repoKey) as { enabled: number } | undefined) : undefined;
  if (repo?.enabled !== 1) return undefined;
  return async (needle) => {
    const since = iso(env.ctx.clock.now() - DAY_MS);
    const look = () =>
      (prepared(env.ctx.db, "SELECT prompt FROM session_prompt WHERE client_id = ? AND repo_key = ? AND received_at > ? AND prompt IS NOT NULL")
        .all(caller.clientId, caller.repoKey ?? "none", since) as { prompt: string }[]).some((p) => norm(p.prompt).includes(needle));
    for (let waited = 0; ; waited += 250) {
      if (look()) return true;
      if (waited >= 1500) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  };
}

/** `expires_at` of an active event (write-path.md §5 D13, D10a). */
function eventExpiry(env: WriteEnv, req: SaveRequest, validFrom: string, tier: TierNum, observedAt: number): string {
  const maxMs = observedAt + env.config.write.event_max_ttl_days * DAY_MS;
  if (req.expires_on) {
    const end = Date.parse(`${req.expires_on}T23:59:59.999Z`);
    return iso(tier === 0 ? end : Math.min(end, maxMs));
  }
  return iso(Date.parse(periodStart(validFrom)) + env.config.write.event_default_ttl_days * DAY_MS);
}

function outcomeFor(env: WriteEnv, stored: StoreResult, key: string, reasonOverride?: string): WriteOutcome {
  const reason = (reasonOverride ?? stored.reason) as ReasonCode;
  const contested = stored.status === "contested";
  return {
    outcome: stored.status === "pending_review" ? "review" : "active",
    reason: contested ? "contested" : reason,
    message: reasonMessage(contested ? "contested" : reason),
    id: stored.memoryId,
    tier: tierLabel(stored.tier),
    section: sectionName(env.ctx, stored.sectionId),
    memory_status: stored.status,
    ...(stored.contestedWith.length > 0 ? { contested_with: [...stored.contestedWith] } : {}),
    idempotency_key: key,
    policy_version: POLICY_VERSION,
  };
}

export async function save(env: WriteEnv, caller: Caller, req: SaveRequest, m: RequestMeta): Promise<SaveResult> {
  const { ctx, config } = env;
  const stored = storedResult(ctx, m.idempotencyKey);
  if (stored) return { kind: "result", outcome: stored };
  preChecks(env, caller, "save");

  const v = await verify(req, { supportMin: config.write.support_min, findInPrompts: promptFinder(env, caller) });
  const registry = loadRegistry(ctx.db);
  const resolution = resolve(ctx.db, registry, { content: v.content, entity: req.entity, attribute: req.attribute, section: req.section });
  const slot = !resolution.entity.isNew && resolution.attribute ? { entityId: resolution.entity.id, attributeId: resolution.attribute.id } : undefined;
  const screens = {
    secretHit: secretHit([v.content, v.userWords, v.whyDurable]),
    instructionHit: instructionHit(v.content, req.kind),
    sensitiveCategory: sensitiveCategory([v.content, v.userWords], config.sensitive.blocked),
    shortLivedHit: shortLivedHit(v.content),
    suppressionHit: isSuppressed(ctx, v.content, slot),
  };
  const scope = req.scope === "repo" && caller.clientClass === "coding" && caller.repoKey && caller.repoKey !== "none" ? `repo:${caller.repoKey}` : "global";
  const scopes = scope === "global" ? ["global", ...(caller.repoKey && caller.repoKey !== "none" ? [`repo:${caller.repoKey}`] : [])] : ["global", scope];
  const duplicate = prepared(ctx.db, 
      `SELECT m.id FROM memory m JOIN memory_version cv ON cv.memory_id = m.id
       WHERE cv.content_norm_hash = ? AND cv.valid_to IS NULL AND cv.expired_at IS NULL AND m.status IN ('active','contested') AND m.scope IN (${scopes.map(() => "?").join(", ")})
       ORDER BY m.created_at, m.id LIMIT 1`,
    )
    .get(v.contentHash, ...scopes) as { id: string } | undefined;

  const input: DecideInput = {
    tier: caller.tier,
    channel: caller.channel === "spool_save" || caller.channel === "capture" || caller.channel === "admin" ? caller.channel : "mcp",
    kind: req.kind,
    explicitRequest: req.explicit_request,
    supersedes: req.supersedes,
    verified: v,
    screens,
    resolution,
    duplicateOf: duplicate?.id,
    floored: caller.floored,
    canElicit: caller.canElicit,
    elicitationAnswer: caller.elicitationAnswer,
  };
  let d = decide(input);
  // Capture without an LLM stages every candidate that passes the screens (write-path.md §10.3).
  if (caller.channel === "capture" && config.llm.provider === "none" && (d.kind === "active" || d.kind === "observation")) {
    d = { row: d.row, kind: "observation", reason: "capture_no_llm", floored: false };
  }
  if (d.kind === "elicit") return { kind: "input_required", question: d.question };

  const suffix = v.userWordsUnsupported ? USER_WORDS_NOT_FOUND_SUFFIX : "";
  const finish = (o: WriteOutcome, touched: readonly string[], op: "save" | "capture"): WriteOutcome => {
    const out = suffix && o.outcome !== "rejected" ? { ...o, reason: o.reason + suffix } : o;
    for (const id of touched) refreshFts(ctx, id);
    recordRequest(env, caller, op, m, out, out);
    return out;
  };
  const op = caller.channel === "capture" ? "capture" : "save";

  if (d.kind === "reject") {
    const out = transaction(ctx.db, () =>
      finish({ outcome: "rejected", reason: d.reason, message: reasonMessage(d.reason), idempotency_key: m.idempotencyKey, policy_version: POLICY_VERSION }, [], op),
    );
    return { kind: "result", outcome: out };
  }

  const [vector] = await env.embedder.embedDocuments([v.content]);
  if (!vector) throw new WriteError("STORE_UNAVAILABLE", "embedding failed");
  const modelId = env.embedder.modelId;
  const dupThreshold = Number(meta(ctx, "dup_threshold"));
  const source = { excerpt: undefined, userWords: v.userWords, observedAt: m.observedAt };
  const validFrom = req.valid_from;

  let touched: readonly string[] = [];
  const out = transaction(ctx.db, () => {
    if (d.kind === "already_stored") {
      const cur = currentVersion(ctx, d.memoryId);
      linkSource(ctx, d.memoryId, cur?.id ?? null, insertSource(ctx, caller), source);
      const memory = prepared(ctx.db, "SELECT section_id, status FROM memory WHERE id = ?").get(d.memoryId) as { section_id: string; status: "active" | "contested" };
      touched = [d.memoryId];
      return finish(outcomeFor(env, { memoryId: d.memoryId, status: memory.status, reason: "already_stored", tier: cur?.trust_tier ?? caller.tier, sectionId: memory.section_id, contestedWith: [], touched }, m.idempotencyKey), touched, op);
    }
    const proposal = {
      resolution, content: v.content, contentHash: v.contentHash, kind: req.kind, scope, tier: caller.tier, reason: d.reason,
      supersedes: req.supersedes, change: req.change, validFrom, observedAt: m.observedAt, expiresAt: undefined, sensitivityCategory: undefined,
      vector, modelId, dupThreshold, writeRequestKey: m.idempotencyKey, source,
    };
    if (d.kind === "review") {
      const r = storeForReview(ctx, caller, { ...proposal, sensitivityCategory: screens.sensitiveCategory }, d.reviewKind);
      touched = r.touched;
      return finish(outcomeFor(env, r, m.idempotencyKey, d.reason), touched, op);
    }
    if (d.kind === "observation") {
      const mention = addMention(ctx, caller, {
        resolution, content: v.content, contentHash: v.contentHash, kind: req.kind === "instruction" ? "fact" : req.kind, scope, tier: caller.tier,
        floored: d.floored, observedAt: m.observedAt, vector, modelId, dupThreshold, writeRequestKey: m.idempotencyKey, source,
      }, config);
      if (mention.promoted) {
        touched = mention.stored.touched;
        return finish(outcomeFor(env, mention.stored, m.idempotencyKey, "recurred"), touched, op);
      }
      const reason = d.reason;
      return finish({
        outcome: "observation", reason, message: reasonMessage(reason), id: mention.observationId, tier: tierLabel(caller.tier),
        section: sectionName(ctx, resolution.sectionId), idempotency_key: m.idempotencyKey, policy_version: POLICY_VERSION,
      }, [], op);
    }
    // active
    const tier = d.tier;
    const expiresAt = req.kind === "event" ? eventExpiry(env, req, validFrom ?? iso(m.observedAt).slice(0, 10), tier, m.observedAt) : undefined;
    const sensitive = d.row === "D4" || d.row === "D5" ? screens.sensitiveCategory : undefined;
    const r = applyStoreRules(ctx, { ...caller, tier }, { ...proposal, tier, expiresAt, sensitivityCategory: sensitive });
    // A confirmed re-save or an owner save lifts the suppression it matched.
    if (screens.suppressionHit && (tier === 0 || d.row === "D7")) liftMatching(ctx, v.content, slot);
    if (d.preferenceConfirm && r.status !== "pending_review" && r.reason !== "already_stored") {
      createReview(ctx, caller, { kind: "preference_confirm", memoryId: r.memoryId, observationId: undefined, payload: undefined });
    }
    touched = r.touched;
    return finish(outcomeFor(env, r, m.idempotencyKey), touched, op);
  });
  prepared(ctx.db, "UPDATE client_policy SET last_policy_version = ?, last_policy_version_at = ? WHERE client_id = ? AND ? IS NOT NULL").run(
    req.policy_version ?? null, iso(ctx.clock.now()), caller.clientId, req.policy_version ?? null,
  );
  env.onCommit?.(touched);
  return { kind: "result", outcome: out };
}

export interface ForgetOutcome {
  readonly id: string;
  readonly outcome: "forgotten" | "review" | "already_forgotten";
  readonly message: string;
  readonly undo_until?: string;
}

const FORGET_MESSAGES = {
  forgotten: "forgotten; the owner can undo this for 30 days",
  review: "this memory is protected; the owner will confirm forgetting it",
  already_forgotten: "already forgotten",
} as const;

export async function forget(env: WriteEnv, caller: Caller, id: string, m: RequestMeta): Promise<{ kind: "result"; outcome: ForgetOutcome } | { kind: "input_required"; question: string }> {
  const { ctx, config } = env;
  const stored = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(m.idempotencyKey) as { result_json: string } | undefined;
  if (stored) return { kind: "result", outcome: JSON.parse(stored.result_json) as ForgetOutcome };
  preChecks(env, caller, "forget");
  const since = iso(ctx.clock.now() - DAY_MS);
  const forgetsToday = (prepared(ctx.db, "SELECT count(*) n FROM write_request WHERE client_id = ? AND op = 'forget' AND outcome IN ('forgotten','review') AND received_at > ?")
    .get(caller.clientId, since) as { n: number }).n;
  const quota = (prepared(ctx.db, "SELECT quota_forgets_per_day q FROM client_policy WHERE client_id = ?").get(caller.clientId) as { q: number } | undefined)?.q ?? 5;
  const r: ForgetResult = forgetByClient(ctx, caller, id, { purgeAfterDays: config.retention.forgotten_purge_days, quotaPerDay: quota, forgetsToday });
  if (r.kind === "elicit") return { kind: "input_required", question: r.question };
  const out: ForgetOutcome = { id, outcome: r.outcome, message: FORGET_MESSAGES[r.outcome], ...(r.undoUntil ? { undo_until: r.undoUntil } : {}) };
  transaction(ctx.db, () => recordRequest(env, caller, "forget", m, { outcome: r.outcome, reason: r.outcome }, out));
  env.onCommit?.(r.touched);
  return { kind: "result", outcome: out };
}
