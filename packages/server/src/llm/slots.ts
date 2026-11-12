// Slot proposal (write-path.md §6.1 step 2.3, §6.2) and its later retry, the `reslot` job.
//
// A free-text save that no hint or pattern filed into a registry slot asks the LLM which slot it
// fills. When the LLM cannot answer in time, the memory is stored unslotted and a `reslot` job asks
// again later. Either way an LLM slot only fills an empty slot or contests the current value; it
// never supersedes (spec-issues #53).
//
//   save ── no slot ──► proposal ──┬─ a slot ────────► re-resolve, decide from D14 again
//                                  ├─ none ──────────► stays unslotted
//                                  ├─ timeout/error/cap ► stored unslotted; reslot job (+5 min, then 1 h, 6 h, 17 h)
//                                  └─ no key ────────► stored unslotted; reslot once a key appears (30 days back)

import type { StoreContext } from "../store/context.ts";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { contest, currentVersion } from "../write/rows.ts";
import { loadRegistry, typeFits, type Registry } from "../write/resolve.ts";
import type { EntityType } from "../write/types.ts";
import type { Llm, LlmAnswer } from "./adapter.ts";
import { slotProposal } from "./prompts.ts";

/** Waits between reslot attempts: the first runs 5 minutes after the save, then 3 retries over 24 h. */
export const RESLOT_FIRST_MS = 5 * 60_000;
export const RESLOT_BACKOFF_MS = [HOUR_MS, 6 * HOUR_MS, 17 * HOUR_MS] as const;

/** How far back saves stored while the key was missing are reslotted (spec-issues #63). */
const BACKFILL_MS = 30 * DAY_MS;
const KEY_MISSING = "llm_key_missing_since";

/**
 * Asks which registry attribute `content` fills. `ok` with undefined means "none" (or no attribute
 * fits the entity, so there was nothing to ask).
 */
export async function proposeSlot(llm: Llm, registry: Registry, s: { content: string; entity: string; entityType: EntityType | undefined }): Promise<LlmAnswer<string | undefined>> {
  const choices = registry.attributes
    .filter((a) => a.restricted === 0 && typeFits(a, s.entityType))
    .map((a) => ({ name: a.name, entityType: a.entity_type, description: a.description }));
  if (choices.length === 0) return { ok: true, value: undefined };
  const a = await llm.ask(slotProposal({ content: s.content, entity: s.entity, entityType: s.entityType, choices }));
  if (!a.ok) return a;
  return { ok: true, value: a.value.attribute === "none" ? undefined : a.value.attribute };
}

export function queueReslot(ctx: StoreContext, memoryId: string): void {
  const now = ctx.clock.now();
  prepared(ctx.db, "INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, 'reslot', ?, 0, ?, 'queued', ?)")
    .run(ctx.ids.newId("job", now), JSON.stringify({ memory_id: memoryId }), iso(now + RESLOT_FIRST_MS), iso(now));
}

/** Remembers that a slot proposal was skipped for lack of a key, so that a key's arrival backfills. */
export function noteKeyMissing(ctx: StoreContext): void {
  prepared(ctx.db, "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(KEY_MISSING, iso(ctx.clock.now()));
}

/**
 * Once a key is present: queues `reslot` for the unslotted model-written memories stored while it
 * was missing (at most 30 days back). Returns how many were queued.
 */
export function backfillAfterKey(ctx: StoreContext): number {
  const since = (prepared(ctx.db, "SELECT value FROM meta WHERE key = ?").get(KEY_MISSING) as { value: string } | undefined)?.value;
  if (!since) return 0;
  const from = iso(Math.max(Date.parse(since), ctx.clock.now() - BACKFILL_MS));
  return transaction(ctx.db, () => {
    const ids = (prepared(ctx.db,
        `SELECT m.id FROM memory m JOIN memory_version v ON v.memory_id = m.id AND v.valid_to IS NULL AND v.expired_at IS NULL
         WHERE m.attribute_id IS NULL AND m.status IN ('active','contested') AND m.created_at >= ? AND v.trust_tier > 0 ORDER BY m.created_at, m.id`,
      )
      .all(from) as { id: string }[]).map((r) => r.id);
    for (const id of ids) queueReslot(ctx, id);
    prepared(ctx.db, "DELETE FROM meta WHERE key = ?").run(KEY_MISSING);
    return ids.length;
  });
}

/** Thrown so the worker retries later (timeout, error, cap). */
export class ReslotRetry extends Error {
  override readonly name = "ReslotRetry";
  readonly code: string;
  constructor(code: string) {
    super(`slot proposal unavailable: ${code}`);
    this.code = code;
  }
}

interface MemoryForReslot {
  readonly id: string;
  readonly entity_id: string;
  readonly entity_type: EntityType;
  readonly entity_name: string;
  readonly attribute_id: string | null;
  readonly section_id: string;
  readonly status: string;
}

/**
 * One `reslot` job. Fills the memory's slot when the LLM names one: alone if the slot is empty (or
 * holds many values), as a contested pair if it holds one other value. A slot that is already a
 * contested pair is left alone. Returns the memories whose search entries changed.
 */
export async function runReslot(ctx: StoreContext, llm: Llm, payloadJson: string): Promise<string[]> {
  const memoryId = (JSON.parse(payloadJson) as { memory_id?: string }).memory_id;
  if (!memoryId) return [];
  const load = (): MemoryForReslot | undefined =>
    prepared(ctx.db,
      `SELECT m.id, m.entity_id, e.type AS entity_type, e.canonical_name AS entity_name, m.attribute_id, m.section_id, m.status
       FROM memory m JOIN entity e ON e.id = m.entity_id WHERE m.id = ?`,
    ).get(memoryId) as MemoryForReslot | undefined;
  const m = load();
  if (!m || m.attribute_id !== null || (m.status !== "active" && m.status !== "contested")) return [];
  const cur = currentVersion(ctx, m.id);
  if (!cur) return [];

  const registry = loadRegistry(ctx.db);
  const a = await proposeSlot(llm, registry, { content: cur.content, entity: m.entity_type === "self" ? "self" : m.entity_name, entityType: m.entity_type });
  if (!a.ok) {
    // Without an LLM there is nothing to retry; without a key, the key's arrival backfills.
    if (a.why === "off") return [];
    if (a.why === "no_key") {
      noteKeyMissing(ctx);
      return [];
    }
    throw new ReslotRetry(a.why);
  }
  const attr = registry.attributes.find((x) => x.name === a.value && x.restricted === 0 && typeFits(x, m.entity_type));
  if (!attr) return [];

  return transaction(ctx.db, () => {
    // The memory may have changed while the model answered.
    const now = load();
    if (!now || now.attribute_id !== null || (now.status !== "active" && now.status !== "contested")) return [];
    const members = attr.cardinality === "one"
      ? (prepared(ctx.db, "SELECT id FROM memory WHERE entity_id = ? AND attribute_id = ? AND status IN ('active','contested') AND id <> ?")
          .all(m.entity_id, attr.id, m.id) as { id: string }[]).map((r) => r.id)
      : [];
    if (members.length > 1) return [];
    prepared(ctx.db, "UPDATE memory SET attribute_id = ?, section_id = ?, updated_at = ? WHERE id = ?").run(attr.id, attr.section_id, iso(ctx.clock.now()), m.id);
    appendEvent(ctx, { actor: "system", op: "memory.reslot", refs: { memory_id: m.id, attribute_id: attr.id }, undo: { prior_section_id: m.section_id } });
    const other = members[0];
    if (other === undefined) return [m.id];
    contest(ctx, other, m.id);
    appendEvent(ctx, { actor: "system", op: "memory.contest", refs: { memory_id: m.id, other_memory_id: other } });
    return [m.id, other];
  });
}
