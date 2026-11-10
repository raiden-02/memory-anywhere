// Row writers for the write path: entities, memories, versions, sources, the FTS index, embeddings,
// contests and review items (data-model.md §2, §5–§8). Every function runs inside the caller's
// write transaction and records an event for each change.

import { normEntity } from "@memory-anywhere/contracts/normalize";
import { appendEvent } from "../store/events.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import type { Caller, EntityType, Resolution, TierNum } from "./types.ts";
import { prepared } from "../store/db.ts";

// ---- dates

export type Precision = "year" | "month" | "day" | "instant";

/** The precision of a partial date or timestamp (data-model.md §1). */
export function precisionOf(value: string): Precision {
  if (/^\d{4}$/.test(value)) return "year";
  if (/^\d{4}-\d{2}$/.test(value)) return "month";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "day";
  return "instant";
}

/** Comparable start of a partial date: "2024" → "2024-01-01T00:00:00.000Z". */
export function periodStart(value: string): string {
  if (/^\d{4}$/.test(value)) return `${value}-01-01T00:00:00.000Z`;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}

export const dateOf = (ms: number): string => iso(ms).slice(0, 10);

// ---- provenance

export function tierBasis(caller: Caller, tier: TierNum): "owner" | "elicitation" | "model" | "capture" | "import" | "promotion" {
  if (tier === 0) return "owner";
  if (caller.channel === "promotion") return "promotion";
  if (tier === 1) return "elicitation";
  if (caller.channel === "capture") return "capture";
  if (caller.channel === "import") return "import";
  return "model";
}

export function extractionMethod(caller: Caller): "live" | "capture" | "import" | "admin" | "promotion" {
  switch (caller.channel) {
    case "capture": return "capture";
    case "import": return "import";
    case "admin":
    case "review_approve": return "admin";
    case "promotion": return "promotion";
    default: return "live";
  }
}

/** The client recorded on a version: 'owner' for T0 (data-model.md §2). */
export const versionClient = (caller: Caller, tier: TierNum): string => (tier === 0 ? "owner" : caller.clientId);

// ---- entities

/** The entity of a resolution, created now if it is new (write-path.md §6.1 step 3). */
export function ensureEntity(ctx: StoreContext, caller: Caller, r: Resolution, tier: TierNum): { id: string; type: EntityType; created: boolean } {
  if (!r.entity.isNew) return { id: r.entity.id, type: r.entity.type, created: false };
  const { db, clock, ids } = ctx;
  const now = iso(clock.now());
  const id = ids.newId("ent", clock.now());
  // A project named by a model is a proposal until the owner approves it.
  const approved = r.entity.type === "project" && tier !== 0 ? 0 : 1;
  prepared(db, "INSERT INTO entity (id, type, canonical_name, status, approved, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(
    id, r.entity.type, r.entity.name, approved, now,
  );
  prepared(db, "INSERT INTO entity_alias (alias_norm, entity_id, origin, approved, created_at) VALUES (?, ?, 'canonical', 1, ?)").run(
    normEntity(r.entity.name), id, now,
  );
  appendEvent(ctx, { actor: caller.clientId, op: "entity.create", refs: { entity_id: id } });
  if (!approved) createReview(ctx, caller, { kind: "project_proposal", memoryId: undefined, observationId: undefined, payload: { entity_id: id } });
  return { id, type: r.entity.type, created: true };
}

// ---- sources

export interface SourceInput {
  readonly excerpt: string | undefined;
  readonly userWords: string | undefined;
  readonly observedAt: number;
}

export function insertSource(ctx: StoreContext, caller: Caller): string {
  const { db, clock, ids } = ctx;
  const id = ids.newId("src", clock.now());
  const cls = caller.channel === "admin" || caller.channel === "review_approve" ? "admin" : caller.channel === "capture" ? "capture" : caller.channel === "import" ? "import" : caller.clientClass;
  prepared(db, "INSERT INTO source (id, client_id, client_class, tool, repo_key, session_key, import_item_key, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run(
    id, caller.clientId, cls, caller.tool ?? null, caller.repoKey ?? null, caller.sessionKey, iso(clock.now()),
  );
  return id;
}

export function linkSource(ctx: StoreContext, memoryId: string, versionId: string | null, sourceId: string, s: SourceInput): void {
  const { db, clock, ids } = ctx;
  prepared(db, "INSERT INTO memory_source (id, memory_id, version_id, source_id, excerpt, user_words, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    ids.newId("msr", clock.now()), memoryId, versionId, sourceId, s.excerpt?.slice(0, 300) ?? null, s.userWords?.slice(0, 200) ?? null, iso(s.observedAt),
  );
}

// ---- memories and versions

export interface MemoryInput {
  readonly entityId: string;
  readonly attributeId: string | undefined;
  readonly sectionId: string;
  readonly kind: string;
  readonly scope: string;
  readonly status: "active" | "contested" | "pending_review" | "superseded";
  readonly sensitivityCategory: string | undefined;
  readonly expiresAt: string | undefined;
  readonly supersededBy?: string | undefined;
}

export function insertMemory(ctx: StoreContext, caller: Caller, m: MemoryInput): string {
  const { db, clock, ids } = ctx;
  const id = ids.newId("mem", clock.now());
  const now = iso(clock.now());
  prepared(db, 
    `INSERT INTO memory (id, entity_id, attribute_id, section_id, kind, scope, status, pinned, sensitivity_category, expires_at,
       superseded_by, created_at, updated_at, created_by_client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, m.entityId, m.attributeId ?? null, m.sectionId, m.kind, m.scope, m.status, m.sensitivityCategory ?? null, m.expiresAt ?? null,
    m.supersededBy ?? null, now, now, caller.clientId);
  return id;
}

export interface VersionInput {
  readonly content: string;
  readonly contentHash: string;
  readonly validFrom: string | undefined;
  readonly validTo?: string | undefined;
  readonly tier: TierNum;
  readonly changeKind: "initial" | "update" | "correction" | "historical" | "undated_historical" | "extension" | "resolution" | "confirmation";
  readonly writeRequestKey: string | undefined;
}

export function insertVersion(ctx: StoreContext, caller: Caller, memoryId: string, v: VersionInput): string {
  const { db, clock, ids } = ctx;
  const id = ids.newId("ver", clock.now());
  prepared(db, 
    `INSERT INTO memory_version (id, memory_id, content, content_norm_hash, valid_from, valid_from_precision, valid_to, valid_to_precision,
       recorded_at, expired_at, trust_tier, tier_basis, extraction_method, change_kind, client_id, write_request_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, memoryId, v.content, v.contentHash,
    v.validFrom ?? null, v.validFrom ? precisionOf(v.validFrom) : null,
    v.validTo ?? null, v.validTo ? precisionOf(v.validTo) : null,
    iso(clock.now()), v.tier, tierBasis(caller, v.tier), extractionMethod(caller), v.changeKind, versionClient(caller, v.tier), v.writeRequestKey ?? null,
  );
  return id;
}

export interface CurrentVersion {
  readonly id: string;
  readonly memory_id: string;
  readonly content: string;
  readonly content_norm_hash: string;
  readonly valid_from: string | null;
  readonly trust_tier: TierNum;
  readonly client_id: string;
  readonly recorded_at: string;
}

export function currentVersion(ctx: StoreContext, memoryId: string): CurrentVersion | undefined {
  return prepared(ctx.db, "SELECT id, memory_id, content, content_norm_hash, valid_from, trust_tier, client_id, recorded_at FROM memory_version WHERE memory_id = ? AND valid_to IS NULL AND expired_at IS NULL")
    .get(memoryId) as CurrentVersion | undefined;
}

export function setMemoryStatus(ctx: StoreContext, memoryId: string, status: string, supersededBy?: string): void {
  prepared(ctx.db, "UPDATE memory SET status = ?, superseded_by = coalesce(?, superseded_by), updated_at = ? WHERE id = ?").run(
    status, supersededBy ?? null, iso(ctx.clock.now()), memoryId,
  );
}

// ---- search index and vectors

/** Rewrites a memory's FTS row: present only while it is active or contested (data-model.md §2). */
export function refreshFts(ctx: StoreContext, memoryId: string): void {
  const { db } = ctx;
  prepared(db, "DELETE FROM memory_fts WHERE version_id IN (SELECT id FROM memory_version WHERE memory_id = ?)").run(memoryId);
  const row = prepared(db, 
      `SELECT v.id, v.content, m.entity_id FROM memory m JOIN memory_version v ON v.memory_id = m.id
       WHERE m.id = ? AND m.status IN ('active','contested') AND v.valid_to IS NULL AND v.expired_at IS NULL`,
    )
    .get(memoryId) as { id: string; content: string; entity_id: string } | undefined;
  if (!row) return;
  const excerpts = (prepared(db, "SELECT excerpt, user_words FROM memory_source WHERE memory_id = ? ORDER BY observed_at").all(memoryId) as {
    excerpt: string | null; user_words: string | null;
  }[]).flatMap((s) => [s.excerpt, s.user_words]).filter((x): x is string => !!x);
  const aliases = (prepared(db, "SELECT alias_norm FROM entity_alias WHERE entity_id = ? AND approved = 1").all(row.entity_id) as { alias_norm: string }[])
    .map((a) => a.alias_norm)
    .filter((a) => a !== "self");
  prepared(db, "INSERT INTO memory_fts (version_id, content, excerpts, aliases) VALUES (?, ?, ?, ?)").run(
    row.id, row.content, [...new Set(excerpts)].join(" \n "), aliases.join(" "),
  );
}

export function insertEmbedding(ctx: StoreContext, ownerType: "version" | "observation", ownerId: string, modelId: string, vector: Float32Array): void {
  prepared(ctx.db, "INSERT OR REPLACE INTO embedding (owner_type, owner_id, model_id, dim, vector) VALUES (?, ?, ?, ?, ?)").run(
    ownerType, ownerId, modelId, vector.length, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
  );
}

export function readEmbedding(ctx: StoreContext, ownerType: "version" | "observation", ownerId: string, modelId: string): Float32Array | undefined {
  const row = prepared(ctx.db, "SELECT vector FROM embedding WHERE owner_type = ? AND owner_id = ? AND model_id = ?").get(ownerType, ownerId, modelId) as
    | { vector: Uint8Array }
    | undefined;
  if (!row) return undefined;
  const bytes = row.vector;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

// ---- contests and review

export function contest(ctx: StoreContext, a: string, b: string): void {
  const now = iso(ctx.clock.now());
  const ins = prepared(ctx.db, "INSERT OR IGNORE INTO memory_contest (memory_id, other_memory_id, created_at) VALUES (?, ?, ?)");
  ins.run(a, b, now);
  ins.run(b, a, now);
  setMemoryStatus(ctx, a, "contested");
  setMemoryStatus(ctx, b, "contested");
}

export type ReviewKind = "instruction" | "sensitive" | "forget_protected" | "contested" | "preference_confirm" | "project_proposal" | "render_sensitive";

export function createReview(
  ctx: StoreContext,
  caller: Caller,
  r: { kind: ReviewKind; memoryId: string | undefined; observationId: string | undefined; payload: Record<string, unknown> | undefined },
): string {
  const id = ctx.ids.newId("rev", ctx.clock.now());
  prepared(ctx.db, "INSERT INTO review_item (id, kind, memory_id, observation_id, payload_json, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, r.kind, r.memoryId ?? null, r.observationId ?? null, r.payload ? JSON.stringify(r.payload) : null, caller.clientId, iso(ctx.clock.now()));
  appendEvent(ctx, { actor: caller.clientId, op: "review.create", refs: { review_id: id, kind: r.kind, memory_id: r.memoryId ?? null } });
  return id;
}
