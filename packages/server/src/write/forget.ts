// Forget, undo and purge (write-path.md §9; data-model.md §5.1, §9).
//
// Forget is soft: the memory stops being recalled, a suppression keeps it from being saved again,
// and the owner can undo it for 30 days. Purge, at `purge_after` or on the owner's request, removes
// every plaintext copy in the store and keeps only hashes.

import { DAY_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { transaction, prepared } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { createReview, currentVersion, refreshFts } from "./rows.ts";
import { addSuppression } from "./suppression.ts";
import { WriteError, type Caller } from "./types.ts";

interface MemoryState {
  readonly id: string;
  readonly status: string;
  readonly scope: string;
  readonly pinned: number;
  readonly sensitivity_category: string | null;
  readonly entity_id: string;
  readonly attribute_id: string | null;
}

export type ForgetResult =
  | { readonly kind: "elicit"; readonly question: string }
  | { readonly kind: "done"; readonly outcome: "forgotten" | "review" | "already_forgotten"; readonly undoUntil: string | undefined; readonly touched: readonly string[] };

/** What a client can forget: what it could recall (pending_review memories are never recalled). */
const RECALLABLE = ["active", "contested"];

/** Soft forget inside the caller's transaction; returns the suppression and version ids for undo. */
function softForget(ctx: StoreContext, actor: string, m: MemoryState, purgeAfterDays: number): string {
  const now = ctx.clock.now();
  const cur = currentVersion(ctx, m.id);
  prepared(ctx.db, "UPDATE memory_version SET expired_at = ? WHERE id = ?").run(iso(now), cur?.id ?? "");
  prepared(ctx.db, "UPDATE memory SET status = 'forgotten', forgotten_at = ?, purge_after = ?, updated_at = ? WHERE id = ?")
    .run(iso(now), iso(now + purgeAfterDays * DAY_MS), iso(now), m.id);
  const slot = m.attribute_id ? { entityId: m.entity_id, attributeId: m.attribute_id } : undefined;
  const suppressionId = cur ? addSuppression(ctx, m.id, cur.content, slot, "forget") : null;
  refreshFts(ctx, m.id);
  appendEvent(ctx, {
    actor,
    op: "memory.forget",
    refs: { memory_id: m.id },
    undo: { prior_status: m.status, version_id: cur?.id ?? null, suppression_id: suppressionId },
  });
  return iso(now + purgeAfterDays * DAY_MS);
}

export interface ForgetOptions {
  readonly purgeAfterDays: number;
  readonly quotaPerDay: number;
  /** Forgets by this client in the last 24 hours (from write_request). */
  readonly forgetsToday: number;
}

/** `memory_forget` from a chat or coding client (write-path.md §9.1). */
export function forgetByClient(ctx: StoreContext, caller: Caller, memoryId: string, o: ForgetOptions): ForgetResult {
  const m = prepared(ctx.db, "SELECT id, status, scope, pinned, sensitivity_category, entity_id, attribute_id FROM memory WHERE id = ?").get(memoryId) as
    | MemoryState
    | undefined;
  const scopes = caller.repoKey && caller.repoKey !== "none" ? ["global", `repo:${caller.repoKey}`] : ["global"];
  // An id the caller could not have recalled is reported exactly like an unknown id.
  if (m && scopes.includes(m.scope) && m.status === "forgotten") return { kind: "done", outcome: "already_forgotten", undoUntil: undefined, touched: [] };
  if (!m || !scopes.includes(m.scope) || !RECALLABLE.includes(m.status)) throw new WriteError("NOT_FOUND", "no memory with that id is visible to this app", "id");
  if (o.forgetsToday >= o.quotaPerDay) throw new WriteError("RATE_LIMITED", "daily forget limit reached", undefined, 3600);

  const cur = currentVersion(ctx, m.id);
  const protectedMemory = cur?.trust_tier === 0 || m.pinned === 1 || m.sensitivity_category !== null;
  if (protectedMemory) {
    if (caller.canElicit && caller.elicitationAnswer === undefined) {
      return { kind: "elicit", question: `Forget this from all your AI apps: “${[...(cur?.content ?? "")].slice(0, 200).join("")}”?` };
    }
    if (!(caller.canElicit && caller.elicitationAnswer === true)) {
      transaction(ctx.db, () => createReview(ctx, caller, { kind: "forget_protected", memoryId: m.id, observationId: undefined, payload: undefined }));
      return { kind: "done", outcome: "review", undoUntil: undefined, touched: [] };
    }
  }
  const undoUntil = transaction(ctx.db, () => softForget(ctx, caller.clientId, m, o.purgeAfterDays));
  return { kind: "done", outcome: "forgotten", undoUntil, touched: [m.id] };
}

/** Owner forget (admin UI, and tests): any id, no quota, no protection check. */
export function forgetByOwner(ctx: StoreContext, memoryId: string, purgeAfterDays: number): void {
  transaction(ctx.db, () => {
    const m = prepared(ctx.db, "SELECT id, status, scope, pinned, sensitivity_category, entity_id, attribute_id FROM memory WHERE id = ?").get(memoryId) as
      | MemoryState
      | undefined;
    if (!m || m.status === "forgotten" || m.status === "purged") return;
    softForget(ctx, "owner", m, purgeAfterDays);
  });
}

/** Undo the latest forget within 30 days: prior status, the version current again, suppression lifted. */
export function undoForget(ctx: StoreContext, memoryId: string): boolean {
  return transaction(ctx.db, () => {
    const m = prepared(ctx.db, "SELECT status, purge_after, entity_id, attribute_id FROM memory WHERE id = ?").get(memoryId) as
      | { status: string; purge_after: string | null; entity_id: string; attribute_id: string | null }
      | undefined;
    if (!m || m.status !== "forgotten" || (m.purge_after && m.purge_after <= iso(ctx.clock.now()))) return false;
    const ev = prepared(ctx.db, "SELECT undo_json FROM event WHERE op = 'memory.forget' AND json_extract(refs_json, '$.memory_id') = ? ORDER BY id DESC LIMIT 1")
      .get(memoryId) as { undo_json: string } | undefined;
    if (!ev) return false;
    const undo = JSON.parse(ev.undo_json) as { prior_status: string; version_id: string | null; suppression_id: string | null };
    if (undo.version_id) prepared(ctx.db, "UPDATE memory_version SET expired_at = NULL WHERE id = ?").run(undo.version_id);
    prepared(ctx.db, "UPDATE memory SET status = ?, forgotten_at = NULL, purge_after = NULL, updated_at = ? WHERE id = ?")
      .run(undo.prior_status, iso(ctx.clock.now()), memoryId);
    if (undo.suppression_id) prepared(ctx.db, "UPDATE suppression SET lifted_at = ? WHERE id = ?").run(iso(ctx.clock.now()), undo.suppression_id);
    refreshFts(ctx, memoryId);
    appendEvent(ctx, { actor: "owner", op: "memory.undo_forget", refs: { memory_id: memoryId } });
    return true;
  });
}

/** Purge one memory: every plaintext copy in the store, in one transaction (data-model.md §9). */
export function purgeMemory(ctx: StoreContext, memoryId: string, actor: string): void {
  transaction(ctx.db, () => {
    const db = ctx.db;
    const m = prepared(db, "SELECT status, entity_id, attribute_id FROM memory WHERE id = ?").get(memoryId) as
      | { status: string; entity_id: string; attribute_id: string | null }
      | undefined;
    if (!m || m.status === "purged") return;
    const versions = prepared(db, "SELECT id, content, content_norm_hash FROM memory_version WHERE memory_id = ?").all(memoryId) as {
      id: string; content: string | null; content_norm_hash: string;
    }[];
    const texts = versions.map((v) => v.content).filter((c): c is string => c !== null);
    const hashes = [...new Set(versions.map((v) => v.content_norm_hash))];
    const slot = m.attribute_id ? { entityId: m.entity_id, attributeId: m.attribute_id } : undefined;

    prepared(db, "UPDATE memory_version SET content = NULL WHERE memory_id = ?").run(memoryId); // 1
    prepared(db, "UPDATE memory_source SET excerpt = NULL, user_words = NULL WHERE memory_id = ?").run(memoryId); // 2
    for (const v of versions) {
      prepared(db, "DELETE FROM embedding WHERE owner_type = 'version' AND owner_id = ?").run(v.id); // 3
      prepared(db, "DELETE FROM memory_fts WHERE version_id = ?").run(v.id); // 4
    }
    prepared(db, "UPDATE review_item SET payload_json = NULL WHERE memory_id = ?").run(memoryId); // 5
    // 6: observations promoted into it, or with the same text.
    const observations = prepared(db, 
        `SELECT id FROM observation WHERE promoted_memory_id = ? OR content_norm_hash IN (${hashes.map(() => "?").join(", ") || "''"})`,
      )
      .all(memoryId, ...hashes) as { id: string }[];
    for (const o of observations) {
      prepared(db, "UPDATE observation SET content = NULL, status = 'purged' WHERE id = ?").run(o.id);
      prepared(db, "UPDATE observation_mention SET content = NULL, excerpt = NULL, user_words = NULL WHERE observation_id = ?").run(o.id);
      prepared(db, "DELETE FROM embedding WHERE owner_type = 'observation' AND owner_id = ?").run(o.id);
    }
    // 7: extraction cache rows of its capture or import sources (no LLM extraction in local mode yet).
    // 8: prompts that contain the text (best effort; they expire within 24 hours anyway).
    for (const t of texts) {
      prepared(db, "UPDATE session_prompt SET prompt = NULL WHERE prompt IS NOT NULL AND instr(lower(prompt), lower(?)) > 0").run(t);
    }
    // 9: the forget's suppression becomes a purge suppression; one is added if there was none.
    const updated = prepared(db, "UPDATE suppression SET reason = 'purge' WHERE memory_id = ? AND lifted_at IS NULL").run(memoryId);
    const latest = texts.at(-1);
    if (Number(updated.changes) === 0 && latest !== undefined) addSuppression(ctx, memoryId, latest, slot, "purge");
    // 10
    prepared(db, "UPDATE memory SET status = 'purged', purged_at = ?, updated_at = ? WHERE id = ?").run(iso(ctx.clock.now()), iso(ctx.clock.now()), memoryId);
    appendEvent(ctx, { actor, op: "memory.purge", refs: { memory_id: memoryId } });
  });
  ctx.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
}

/** The purge job: every forgotten memory past `purge_after`; returns their ids. */
export function purgeDue(ctx: StoreContext, mode: "local" | "aws"): string[] {
  const due = (prepared(ctx.db, "SELECT id FROM memory WHERE status = 'forgotten' AND purge_after <= ? ORDER BY id").all(iso(ctx.clock.now())) as { id: string }[]).map((d) => d.id);
  for (const id of due) purgeMemory(ctx, id, "job:purge");
  // Local mode has no Litestream: fold the WAL back so freed pages leave the -wal file now.
  if (due.length > 0 && mode === "local") ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return due;
}
