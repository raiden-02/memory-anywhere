// Observations: passing mentions staged until they recur (memory-policy.md §8; write-path.md §8.3).
// A mention joins an open observation with the same content hash, or on the same entity and
// attribute with cosine ≥ dup_threshold; otherwise it opens a new one. When the counted mentions
// come from at least `promote_min_sessions` distinct sessions, the observation is promoted through
// the store rules and the triggering save reports `active`, reason `recurred`.

import { appendEvent } from "../store/events.ts";
import { HOUR_MS, iso, DAY_MS } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import type { ServerConfigT } from "../config/schema.ts";
import { cosine, createReview, dateOf, ensureEntity, insertEmbedding, insertSource, readEmbedding, type SourceInput } from "./rows.ts";
import { applyStoreRules, type StoreResult } from "./store-rules.ts";
import type { Caller, Resolution, TierNum } from "./types.ts";
import { prepared } from "../store/db.ts";

export interface MentionInput {
  readonly resolution: Resolution;
  readonly content: string;
  readonly contentHash: string;
  readonly kind: "fact" | "preference" | "event";
  readonly scope: string;
  readonly tier: TierNum;
  readonly floored: boolean;
  readonly observedAt: number;
  readonly vector: Float32Array;
  readonly modelId: string;
  readonly dupThreshold: number;
  readonly writeRequestKey: string;
  readonly source: SourceInput;
}

export type MentionResult =
  | { readonly promoted: false; readonly observationId: string }
  | { readonly promoted: true; readonly observationId: string; readonly stored: StoreResult };

interface ObservationRow {
  readonly id: string;
  readonly content: string;
  readonly kind: "fact" | "preference" | "event";
  readonly first_seen: string;
  readonly best_tier: TierNum;
}

interface MentionRow {
  readonly client_id: string;
  readonly client_class: string | null;
  readonly floored: number;
  readonly session_key: string;
  readonly trust_tier: TierNum;
  readonly content: string | null;
  readonly observed_at: string;
  readonly source_id: string;
  readonly excerpt: string | null;
  readonly user_words: string | null;
}

function findOpen(ctx: StoreContext, m: MentionInput, entityId: string | undefined, attributeId: string | undefined): ObservationRow | undefined {
  const cols = "id, content, kind, first_seen, best_tier";
  const byHash = prepared(ctx.db, `SELECT ${cols} FROM observation WHERE status = 'open' AND content_norm_hash = ? ORDER BY first_seen, id LIMIT 1`).get(m.contentHash) as
    | ObservationRow
    | undefined;
  if (byHash || !entityId) return byHash;
  const sameSlot = prepared(ctx.db, `SELECT ${cols} FROM observation WHERE status = 'open' AND entity_id = ? AND attribute_id IS ? ORDER BY first_seen, id`)
    .all(entityId, attributeId ?? null) as unknown as ObservationRow[];
  let best: { row: ObservationRow; score: number } | undefined;
  for (const row of sameSlot) {
    const v = readEmbedding(ctx, "observation", row.id, m.modelId);
    const score = v ? cosine(m.vector, v) : -1;
    if (score >= m.dupThreshold && (!best || score > best.score)) best = { row, score };
  }
  return best?.row;
}

/**
 * Distinct sessions among mentions (write-path.md §2.2): different session keys, except that two
 * chat-app keys of one client also need `observed_at` at least `gapHours` apart. Mentions with
 * `floored = 1` count only when an unfloored mention exists.
 */
export function countedSessions(mentions: readonly MentionRow[], gapHours: number): { count: number; counted: MentionRow[] } {
  const anyUnfloored = mentions.some((m) => m.floored === 0);
  const counted = mentions.filter((m) => m.floored === 0 || anyUnfloored).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const sessions: MentionRow[] = [];
  for (const m of counted) {
    const sameKey = sessions.some((s) => s.session_key === m.session_key);
    const tooClose =
      m.client_class === "chat" &&
      sessions.some((s) => s.client_id === m.client_id && Math.abs(Date.parse(m.observed_at) - Date.parse(s.observed_at)) < gapHours * HOUR_MS);
    if (!sameKey && !tooClose) sessions.push(m);
  }
  return { count: sessions.length, counted };
}

/** Adds one mention; promotes the observation when it has recurred. */
export function addMention(ctx: StoreContext, caller: Caller, m: MentionInput, config: ServerConfigT): MentionResult {
  const seen = iso(m.observedAt);
  const entity = ensureEntity(ctx, caller, m.resolution, m.tier);
  const attributeId = m.resolution.attribute?.id;
  const ttl = config.observation.ttl_days * DAY_MS;

  let obs = findOpen(ctx, m, entity.id, attributeId);
  if (!obs) {
    capOpenObservations(ctx, caller, config.observation.max_open_per_client);
    const id = ctx.ids.newId("obs", ctx.clock.now());
    prepared(ctx.db, 
        `INSERT INTO observation (id, content, content_norm_hash, kind, entity_id, attribute_id, section_id, best_tier, mention_count,
           first_seen, last_seen, expires_at, status, created_by_client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'open', ?)`,
      )
      .run(id, m.content, m.contentHash, m.kind, entity.id, attributeId ?? null, m.resolution.sectionId, m.tier, seen, seen,
        iso(m.observedAt + ttl), caller.clientId);
    insertEmbedding(ctx, "observation", id, m.modelId, m.vector);
    appendEvent(ctx, { actor: caller.clientId, op: "observation.create", refs: { observation_id: id } });
    obs = { id, content: m.content, kind: m.kind, first_seen: seen, best_tier: m.tier };
  }

  const sourceId = insertSource(ctx, caller);
  prepared(ctx.db, 
      `INSERT INTO observation_mention (id, observation_id, source_id, client_id, floored, content, trust_tier, session_key, excerpt, user_words,
         observed_at, write_request_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.newId("omn", ctx.clock.now()), obs.id, sourceId, caller.clientId, m.floored ? 1 : 0, m.content, m.tier, caller.sessionKey,
      m.source.excerpt ?? null, m.source.userWords ?? null, seen, m.writeRequestKey);
  prepared(ctx.db, "UPDATE observation SET mention_count = mention_count + 1, last_seen = max(last_seen, ?), expires_at = ?, best_tier = min(best_tier, ?) WHERE id = ?")
    .run(seen, iso(m.observedAt + ttl), m.tier, obs.id);
  appendEvent(ctx, { actor: caller.clientId, op: "observation.mention", refs: { observation_id: obs.id } });

  const mentions = prepared(ctx.db, 
      `SELECT om.client_id, cp.class AS client_class, om.floored, om.session_key, om.trust_tier, om.content, om.observed_at, om.source_id,
              om.excerpt, om.user_words
       FROM observation_mention om LEFT JOIN client_policy cp ON cp.client_id = om.client_id WHERE om.observation_id = ?`,
    )
    .all(obs.id) as unknown as MentionRow[];
  const { count, counted } = countedSessions(mentions, config.observation.chat_session_gap_hours);
  if (count < config.observation.promote_min_sessions) return { promoted: false, observationId: obs.id };

  // Promotion: the most trusted counted tier, the latest counted text, every mention as a source.
  const latest = counted.at(-1) as MentionRow;
  const tier = Math.min(...counted.map((c) => c.trust_tier)) as TierNum;
  const promoter: Caller = { ...caller, channel: "promotion", clientId: latest.client_id, tier };
  const stored = applyStoreRules(ctx, promoter, {
    resolution: { ...m.resolution, entity: { id: entity.id, type: entity.type, isNew: false } },
    content: latest.content ?? m.content,
    contentHash: m.contentHash,
    kind: obs.kind,
    scope: m.scope,
    tier,
    reason: "recurred",
    supersedes: undefined,
    change: "update",
    validFrom: dateOf(Date.parse(obs.first_seen)),
    observedAt: m.observedAt,
    expiresAt: undefined,
    sensitivityCategory: undefined,
    vector: m.vector,
    modelId: m.modelId,
    dupThreshold: m.dupThreshold,
    writeRequestKey: m.writeRequestKey,
    source: m.source,
    extraSources: mentions.map((x) => ({
      sourceId: x.source_id,
      input: { excerpt: x.excerpt ?? undefined, userWords: x.user_words ?? undefined, observedAt: Date.parse(x.observed_at) },
    })),
  });
  prepared(ctx.db, "UPDATE observation SET status = 'promoted', promoted_memory_id = ? WHERE id = ?").run(stored.memoryId, obs.id);
  appendEvent(ctx, { actor: caller.clientId, op: "observation.promote", refs: { observation_id: obs.id, memory_id: stored.memoryId } });
  if (obs.kind === "preference" && stored.status !== "pending_review") {
    createReview(ctx, caller, { kind: "preference_confirm", memoryId: stored.memoryId, observationId: obs.id, payload: undefined });
  }
  return { promoted: true, observationId: obs.id, stored: { ...stored, reason: stored.reason === "already_stored" ? "already_stored" : "recurred" } };
}

/** At the cap of open observations per client, the oldest one expires (memory-policy.md §8). */
function capOpenObservations(ctx: StoreContext, caller: Caller, max: number): void {
  const open = (prepared(ctx.db, "SELECT count(*) n FROM observation WHERE status = 'open' AND created_by_client_id = ?").get(caller.clientId) as { n: number }).n;
  if (open < max) return;
  const oldest = prepared(ctx.db, "SELECT id FROM observation WHERE status = 'open' AND created_by_client_id = ? ORDER BY last_seen, id LIMIT ?")
    .all(caller.clientId, open - max + 1) as { id: string }[];
  for (const o of oldest) {
    prepared(ctx.db, "UPDATE observation SET status = 'expired' WHERE id = ?").run(o.id);
    appendEvent(ctx, { actor: "system", op: "observation.expire", refs: { observation_id: o.id, reason: "cap" } });
  }
}
