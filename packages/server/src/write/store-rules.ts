// Step 7, the store rules (write-path.md §8, rights matrix §8.2; version semantics in
// data-model.md §6). Called for an `active` decision, for observation promotion and for review
// approval, inside the write transaction. "Rights" means the new tier is at least as trusted as
// the current version's tier (a lower number).
//
// Rule order: 0 explicit supersede, 1 same text already stored, then for a `one` slot 2 dated
// history, 3 undated history, 4a profile key across clients, 4 update, 5 contest; then 6 near
// duplicate on the same entity and attribute, and 7 insert.

import { norm } from "@memory-anywhere/contracts/normalize";
import { appendEvent } from "../store/events.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared } from "../store/db.ts";
import {
  contest, cosine, createReview, currentVersion, dateOf, ensureEntity, insertEmbedding, insertMemory, insertSource, insertVersion, linkSource,
  periodStart, precisionOf, readEmbedding, setMemoryStatus, type CurrentVersion, type SourceInput,
} from "./rows.ts";
import type { AttributeRow, Caller, Resolution, TierNum } from "./types.ts";
import { WriteError } from "./types.ts";

export const PROJECT_STATUSES = ["idea", "active", "paused", "shipped", "archived"] as const;

export interface StoreProposal {
  readonly resolution: Resolution;
  readonly content: string;
  readonly contentHash: string;
  readonly kind: string;
  /** 'global' or 'repo:rk_…'. */
  readonly scope: string;
  readonly tier: TierNum;
  /** The decision's reason, used when a new memory is inserted (rule 7). */
  readonly reason: string;
  readonly supersedes: string | undefined;
  readonly change: "update" | "correction";
  /** The valid_from the caller gave, if any. */
  readonly validFrom: string | undefined;
  readonly observedAt: number;
  readonly expiresAt: string | undefined;
  readonly sensitivityCategory: string | undefined;
  /** Embedding of doc_prefix + content, computed before the transaction. */
  readonly vector: Float32Array;
  readonly modelId: string;
  readonly dupThreshold: number;
  readonly writeRequestKey: string | undefined;
  readonly source: SourceInput;
  /** Extra sources to link (observation mentions on promotion). */
  readonly extraSources?: readonly { readonly sourceId: string; readonly input: SourceInput }[];
}

export interface StoreResult {
  readonly memoryId: string;
  readonly status: "active" | "contested" | "pending_review" | "superseded";
  readonly reason: string;
  readonly tier: TierNum;
  readonly sectionId: string;
  readonly contestedWith: readonly string[];
  /** Memories whose current version or status changed (for the search and vector indexes). */
  readonly touched: readonly string[];
}

interface MemoryRow {
  readonly id: string;
  readonly entity_id: string;
  readonly attribute_id: string | null;
  readonly section_id: string;
  readonly kind: string;
  readonly scope: string;
  readonly status: string;
}

const visibleScope = (caller: Caller): string[] => (caller.repoKey && caller.repoKey !== "none" ? ["global", `repo:${caller.repoKey}`] : ["global"]);

function memoryRow(ctx: StoreContext, id: string): MemoryRow | undefined {
  return prepared(ctx.db, "SELECT id, entity_id, attribute_id, section_id, kind, scope, status FROM memory WHERE id = ?").get(id) as MemoryRow | undefined;
}

function contestPartners(ctx: StoreContext, memoryId: string): string[] {
  return (prepared(ctx.db, "SELECT other_memory_id FROM memory_contest WHERE memory_id = ? AND resolved_at IS NULL").all(memoryId) as {
    other_memory_id: string;
  }[]).map((r) => r.other_memory_id);
}

/** The slot's attribute, unless its value is not allowed there (write-path.md §8, project.status). */
function slotAttribute(attr: AttributeRow | undefined, content: string): AttributeRow | undefined {
  if (attr?.name === "project.status" && !new RegExp(`\\b(?:${PROJECT_STATUSES.join("|")})\\b`, "u").test(norm(content))) return undefined;
  return attr;
}

/** A new version on an existing memory, closing the current one per `change` (data-model.md §6). */
function newVersionOn(
  ctx: StoreContext, caller: Caller, p: StoreProposal, cur: CurrentVersion, change: "update" | "correction" | "extension",
): string {
  const now = iso(ctx.clock.now());
  let validFrom: string | null;
  if (change === "update") {
    validFrom = p.validFrom ?? dateOf(p.observedAt);
    prepared(ctx.db, "UPDATE memory_version SET valid_to = ?, valid_to_precision = ? WHERE id = ?").run(validFrom, precisionOf(validFrom), cur.id);
  } else {
    validFrom = change === "correction" ? (p.validFrom ?? cur.valid_from) : cur.valid_from;
    prepared(ctx.db, "UPDATE memory_version SET expired_at = ? WHERE id = ?").run(now, cur.id);
  }
  const versionId = insertVersion(ctx, caller, cur.memory_id, {
    content: p.content, contentHash: p.contentHash, validFrom: validFrom ?? undefined, tier: p.tier, changeKind: change, writeRequestKey: p.writeRequestKey,
  });
  insertEmbedding(ctx, "version", versionId, p.modelId, p.vector);
  prepared(ctx.db, "UPDATE memory SET updated_at = ? WHERE id = ?").run(now, cur.memory_id);
  return versionId;
}

function linkAllSources(ctx: StoreContext, caller: Caller, p: StoreProposal, memoryId: string, versionId: string | null): void {
  linkSource(ctx, memoryId, versionId, insertSource(ctx, caller), p.source);
  for (const extra of p.extraSources ?? []) linkSource(ctx, memoryId, versionId, extra.sourceId, extra.input);
}

/** Inserts a new memory with its first version. */
function insertNew(
  ctx: StoreContext, caller: Caller, p: StoreProposal, entityId: string, attr: AttributeRow | undefined,
  status: "active" | "contested" | "pending_review" | "superseded",
  version: { validFrom: string | undefined; validTo?: string | undefined; changeKind: "initial" | "historical" | "undated_historical" },
  supersededBy?: string,
): string {
  const memoryId = insertMemory(ctx, caller, {
    entityId, attributeId: attr?.id, sectionId: p.resolution.sectionId, kind: p.kind, scope: p.scope, status,
    sensitivityCategory: p.sensitivityCategory, expiresAt: p.expiresAt, supersededBy,
  });
  const versionId = insertVersion(ctx, caller, memoryId, {
    content: p.content, contentHash: p.contentHash, validFrom: version.validFrom, validTo: version.validTo, tier: p.tier,
    changeKind: version.changeKind, writeRequestKey: p.writeRequestKey,
  });
  insertEmbedding(ctx, "version", versionId, p.modelId, p.vector);
  linkAllSources(ctx, caller, p, memoryId, versionId);
  appendEvent(ctx, { actor: caller.clientId, op: "memory.insert", refs: { memory_id: memoryId, version_id: versionId, status } });
  return memoryId;
}

const result = (r: Omit<StoreResult, "contestedWith"> & { contestedWith?: readonly string[] }): StoreResult => ({ contestedWith: [], ...r });

/** Stores a pending_review memory and its review item (decision outcome `review`). */
export function storeForReview(ctx: StoreContext, caller: Caller, p: StoreProposal, reviewKind: "instruction" | "sensitive" | "contested"): StoreResult {
  const entity = ensureEntity(ctx, caller, p.resolution, p.tier);
  const attr = slotAttribute(p.resolution.attribute, p.content);
  const memoryId = insertNew(ctx, caller, p, entity.id, attr, "pending_review", { validFrom: p.validFrom ?? dateOf(p.observedAt), changeKind: "initial" });
  createReview(ctx, caller, { kind: reviewKind, memoryId, observationId: undefined, payload: undefined });
  return result({ memoryId, status: "pending_review", reason: p.reason, tier: p.tier, sectionId: p.resolution.sectionId, touched: [memoryId] });
}

export function applyStoreRules(ctx: StoreContext, caller: Caller, p: StoreProposal): StoreResult {
  const scopes = visibleScope(caller);

  // Rule 0: an explicit supersede of memory X.
  if (p.supersedes) {
    const x = memoryRow(ctx, p.supersedes);
    if (!x || !["active", "contested"].includes(x.status) || !scopes.includes(x.scope)) {
      throw new WriteError("NOT_FOUND", "no memory with that id is visible to this app", "supersedes");
    }
    const cur = currentVersion(ctx, x.id);
    if (!cur) throw new WriteError("NOT_FOUND", "no memory with that id is visible to this app", "supersedes");
    if (p.tier <= cur.trust_tier) {
      const versionId = newVersionOn(ctx, caller, p, cur, p.change);
      linkAllSources(ctx, caller, p, x.id, versionId);
      const touched = [x.id];
      // A rule-0 save with rights resolves a contest: the other side is superseded.
      const now = iso(ctx.clock.now());
      for (const other of contestPartners(ctx, x.id)) {
        setMemoryStatus(ctx, other, "superseded", x.id);
        prepared(ctx.db, "UPDATE memory_contest SET resolved_at = ?, resolution = 'kept_this' WHERE memory_id = ? AND other_memory_id = ?").run(now, x.id, other);
        prepared(ctx.db, "UPDATE memory_contest SET resolved_at = ?, resolution = 'kept_other' WHERE memory_id = ? AND other_memory_id = ?").run(now, other, x.id);
        touched.push(other);
      }
      setMemoryStatus(ctx, x.id, "active");
      appendEvent(ctx, { actor: caller.clientId, op: `memory.${p.change}`, refs: { memory_id: x.id, version_id: versionId }, undo: { prior_version_id: cur.id } });
      return result({ memoryId: x.id, status: "active", reason: p.change, tier: p.tier, sectionId: x.section_id, touched });
    }
    if (contestPartners(ctx, x.id).length > 0) return storeForReview(ctx, caller, p, "contested");
    const entityId = x.entity_id;
    const attr = x.attribute_id ? p.resolution.attribute : undefined;
    const memoryId = insertNew(ctx, caller, { ...p, resolution: { ...p.resolution, sectionId: x.section_id } }, entityId, attr, "contested", {
      validFrom: p.validFrom ?? dateOf(p.observedAt), changeKind: "initial",
    });
    contest(ctx, x.id, memoryId);
    appendEvent(ctx, { actor: caller.clientId, op: "memory.contest", refs: { memory_id: memoryId, other_memory_id: x.id } });
    return result({ memoryId, status: "contested", reason: "contested", tier: p.tier, sectionId: x.section_id, contestedWith: [x.id], touched: [memoryId, x.id] });
  }

  // Rule 1: the same text is already stored, on any entity, in scope.
  const placeholders = scopes.map(() => "?").join(", ");
  const same = prepared(ctx.db, 
      `SELECT m.id FROM memory m JOIN memory_version v ON v.memory_id = m.id
       WHERE v.content_norm_hash = ? AND v.valid_to IS NULL AND v.expired_at IS NULL AND m.status IN ('active','contested') AND m.scope IN (${placeholders})
       ORDER BY m.created_at, m.id LIMIT 1`,
    )
    .get(p.contentHash, ...scopes) as { id: string } | undefined;
  if (same) {
    const cur = currentVersion(ctx, same.id);
    linkAllSources(ctx, caller, p, same.id, cur?.id ?? null);
    appendEvent(ctx, { actor: caller.clientId, op: "memory.source_add", refs: { memory_id: same.id } });
    const m = memoryRow(ctx, same.id);
    return result({ memoryId: same.id, status: (m?.status ?? "active") as "active", reason: "already_stored", tier: cur?.trust_tier ?? p.tier, sectionId: m?.section_id ?? p.resolution.sectionId, touched: [same.id] });
  }

  const entity = ensureEntity(ctx, caller, p.resolution, p.tier);
  const attr = slotAttribute(p.resolution.attribute, p.content);

  // Rules 2–5: a `one` slot that is already filled.
  if (attr?.cardinality === "one" && !entity.created) {
    const members = (prepared(ctx.db, "SELECT m.id FROM memory m WHERE m.entity_id = ? AND m.attribute_id = ? AND m.status IN ('active','contested') ORDER BY m.created_at, m.id")
      .all(entity.id, attr.id) as { id: string }[])
      .map((m) => currentVersion(ctx, m.id))
      .filter((v): v is CurrentVersion => v !== undefined);
    // A slot the LLM proposed never updates its current value (spec-issues #53); a value that only
    // rephrases a member is the same fact, which rule 6 links as a source instead of contesting it.
    const llm = p.resolution.slotFromLlm;
    const rephrases = llm && members.some((m) => cosine(p.vector, readEmbedding(ctx, "version", m.id, p.modelId) ?? new Float32Array(p.vector.length)) >= p.dupThreshold);
    if (members.length > 0 && !rephrases) {
      // The current occupant: the most trusted member, the most recent among equals.
      const cur = [...members].sort((a, b) => a.trust_tier - b.trust_tier || b.recorded_at.localeCompare(a.recorded_at))[0] as CurrentVersion;
      // Rule 2: an older dated value arrives after the current one.
      if (p.validFrom && cur.valid_from && periodStart(p.validFrom) < periodStart(cur.valid_from)) {
        const memoryId = insertNew(ctx, caller, p, entity.id, attr, "superseded", { validFrom: p.validFrom, validTo: cur.valid_from, changeKind: "historical" }, cur.memory_id);
        return result({ memoryId, status: "superseded", reason: "historical", tier: p.tier, sectionId: p.resolution.sectionId, touched: [memoryId] });
      }
      // Rule 3: an undated import below a model-written current value.
      if (p.tier === 3 && !p.validFrom && cur.trust_tier <= 2) {
        const memoryId = insertNew(ctx, caller, p, entity.id, attr, "superseded", { validFrom: undefined, validTo: cur.valid_from ?? undefined, changeKind: "undated_historical" }, cur.memory_id);
        return result({ memoryId, status: "superseded", reason: "historical", tier: p.tier, sectionId: p.resolution.sectionId, touched: [memoryId] });
      }
      if (members.length > 1) {
        // A contested slot keeps exactly one pair: update the least trusted member the caller may
        // change, or send the value to the owner (spec-issues #32).
        const target = llm ? undefined : [...members].filter((m) => p.tier <= m.trust_tier).sort((a, b) => b.trust_tier - a.trust_tier || b.recorded_at.localeCompare(a.recorded_at))[0];
        if (!target) return storeForReview(ctx, caller, p, "contested");
        return updateSlot(ctx, caller, p, target, members.filter((m) => m.memory_id !== target.memory_id).map((m) => m.memory_id));
      }
      // Rule 4a: a profile key written at T2 by another client is contested, not overwritten.
      const crossClient = attr.profile_key === 1 && p.tier === 2 && cur.trust_tier === 2 && cur.client_id !== caller.clientId;
      // Rule 4: rights over the current value, through a hint or pattern slot.
      if (!crossClient && !llm && p.tier <= cur.trust_tier) return updateSlot(ctx, caller, p, cur, []);
      // Rules 4a and 5, and an LLM slot: both values stay, contested.
      const memoryId = insertNew(ctx, caller, p, entity.id, attr, "contested", { validFrom: p.validFrom ?? dateOf(p.observedAt), changeKind: "initial" });
      contest(ctx, cur.memory_id, memoryId);
      appendEvent(ctx, { actor: caller.clientId, op: "memory.contest", refs: { memory_id: memoryId, other_memory_id: cur.memory_id } });
      return result({ memoryId, status: "contested", reason: "contested", tier: p.tier, sectionId: p.resolution.sectionId, contestedWith: [cur.memory_id], touched: [memoryId, cur.memory_id] });
    }
  }

  // Rule 6: a near duplicate on the same entity and attribute.
  if (!entity.created) {
    const candidates = (prepared(ctx.db, 
        `SELECT m.id FROM memory m WHERE m.entity_id = ? AND m.attribute_id IS ? AND m.status IN ('active','contested') AND m.scope IN (${placeholders})`,
      )
      .all(entity.id, attr?.id ?? null, ...scopes) as { id: string }[])
      .map((m) => currentVersion(ctx, m.id))
      .filter((v): v is CurrentVersion => v !== undefined)
      .map((v) => ({ v, score: cosine(p.vector, readEmbedding(ctx, "version", v.id, p.modelId) ?? new Float32Array(p.vector.length)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const best = candidates[0];
    if (best && best.score >= p.dupThreshold) {
      const old = best.v;
      const extends_ = norm(p.content).includes(norm(old.content)) && norm(p.content).length > norm(old.content).length;
      if (extends_ && p.tier <= old.trust_tier) {
        const versionId = newVersionOn(ctx, caller, p, old, "extension");
        linkAllSources(ctx, caller, p, old.memory_id, versionId);
        appendEvent(ctx, { actor: caller.clientId, op: "memory.extension", refs: { memory_id: old.memory_id, version_id: versionId }, undo: { prior_version_id: old.id } });
      } else {
        linkAllSources(ctx, caller, p, old.memory_id, old.id);
        appendEvent(ctx, { actor: caller.clientId, op: "memory.source_add", refs: { memory_id: old.memory_id } });
      }
      const m = memoryRow(ctx, old.memory_id);
      return result({ memoryId: old.memory_id, status: (m?.status ?? "active") as "active", reason: "already_stored", tier: old.trust_tier, sectionId: m?.section_id ?? p.resolution.sectionId, touched: [old.memory_id] });
    }
  }

  // Rule 7: a new memory.
  const memoryId = insertNew(ctx, caller, p, entity.id, attr, "active", { validFrom: p.validFrom ?? dateOf(p.observedAt), changeKind: "initial" });
  return result({ memoryId, status: "active", reason: p.reason, tier: p.tier, sectionId: p.resolution.sectionId, touched: [memoryId] });
}

/** Rule 4: the slot's memory gets the new value as an update; its contest partners stay. */
function updateSlot(ctx: StoreContext, caller: Caller, p: StoreProposal, cur: CurrentVersion, partners: readonly string[]): StoreResult {
  const versionId = newVersionOn(ctx, caller, p, cur, "update");
  linkAllSources(ctx, caller, p, cur.memory_id, versionId);
  appendEvent(ctx, { actor: caller.clientId, op: "memory.update", refs: { memory_id: cur.memory_id, version_id: versionId }, undo: { prior_version_id: cur.id } });
  const m = memoryRow(ctx, cur.memory_id);
  const status = (m?.status ?? "active") as "active" | "contested";
  return result({ memoryId: cur.memory_id, status, reason: "update", tier: p.tier, sectionId: m?.section_id ?? p.resolution.sectionId, contestedWith: status === "contested" ? partners : [], touched: [cur.memory_id] });
}

