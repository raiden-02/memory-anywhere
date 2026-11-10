// Owner decisions on review items (data-model.md §5.1; `mema review --approve/--reject`).
//
// | Kind                          | Approve                                              | Reject                         |
// | instruction, sensitive,       | the held memory becomes active at T0; in a `one`     | the held memory is forgotten,  |
// |   contested                   |   slot it replaces the other values                  |   with no suppression          |
// | preference_confirm            | the preference is confirmed at T0                    | it stays at T2                 |
// | project_proposal              | the project entity is approved                       | it stays a proposal            |
// | forget_protected              | the memory is forgotten (undo for 30 days)           | nothing changes                |
//
// Other kinds (render_sensitive, import and section proposals) need the content in front of the
// owner, so they are resolved in the admin UI (M2).

import { DAY_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { LOCAL_CLIENT_ID } from "../store/init.ts";
import { forgetByOwner } from "./forget.ts";
import { currentVersion, insertVersion, refreshFts, setMemoryStatus } from "./rows.ts";
import { WriteError, type Caller } from "./types.ts";

export const CLI_REVIEW_KINDS = ["instruction", "sensitive", "contested", "preference_confirm", "project_proposal", "forget_protected"] as const;

export interface ReviewDecision {
  readonly id: string;
  readonly resolution: "approved" | "rejected";
}

interface Item {
  readonly id: string;
  readonly kind: string;
  readonly memory_id: string | null;
  readonly payload_json: string | null;
  readonly resolved_at: string | null;
}

const OWNER: Caller = {
  clientId: LOCAL_CLIENT_ID, clientClass: "coding", channel: "review_approve", tier: 0, sessionKey: "admin", repoKey: undefined, tool: undefined,
  floored: false, canElicit: false, elicitationAnswer: undefined,
};

/** Resolves each item; returns the memories whose search entries changed. Unknown or resolved ids fail the whole call. */
export function resolveReviews(ctx: StoreContext, decisions: readonly ReviewDecision[], purgeAfterDays: number): string[] {
  const touched: string[] = [];
  transaction(ctx.db, () => {
    for (const d of decisions) {
      const item = prepared(ctx.db, "SELECT id, kind, memory_id, payload_json, resolved_at FROM review_item WHERE id = ?").get(d.id) as Item | undefined;
      if (!item || item.resolved_at !== null) throw new WriteError("NOT_FOUND", `no open review item ${d.id}`, "id");
      if (!(CLI_REVIEW_KINDS as readonly string[]).includes(item.kind)) throw new WriteError("INVALID_INPUT", `${item.kind} items are resolved in the admin UI`, "id");
      touched.push(...(d.resolution === "approved" ? approve(ctx, item, purgeAfterDays) : reject(ctx, item, purgeAfterDays)));
      prepared(ctx.db, "UPDATE review_item SET resolved_at = ?, resolution = ? WHERE id = ?").run(iso(ctx.clock.now()), d.resolution, item.id);
      appendEvent(ctx, { actor: "owner", op: "review.resolve", refs: { review_id: item.id, kind: item.kind, resolution: d.resolution, memory_id: item.memory_id } });
    }
  });
  return touched;
}

function approve(ctx: StoreContext, item: Item, purgeAfterDays: number): string[] {
  switch (item.kind) {
    case "project_proposal": {
      const entityId = (JSON.parse(item.payload_json ?? "{}") as { entity_id?: string }).entity_id;
      if (entityId) prepared(ctx.db, "UPDATE entity SET approved = 1 WHERE id = ?").run(entityId);
      return [];
    }
    case "forget_protected":
      if (item.memory_id) forgetByOwner(ctx, item.memory_id, purgeAfterDays);
      return item.memory_id ? [item.memory_id] : [];
    case "preference_confirm":
      return item.memory_id ? confirm(ctx, item.memory_id) : [];
    default: // instruction, sensitive, contested: a held memory
      return item.memory_id ? activateHeld(ctx, item.memory_id) : [];
  }
}

function reject(ctx: StoreContext, item: Item, purgeAfterDays: number): string[] {
  if (!item.memory_id || !["instruction", "sensitive", "contested"].includes(item.kind)) return [];
  const m = prepared(ctx.db, "SELECT status FROM memory WHERE id = ?").get(item.memory_id) as { status: string } | undefined;
  if (m?.status !== "pending_review") return [];
  // Rejected, not forgotten by the user: no suppression, so a later save is judged afresh.
  const now = ctx.clock.now();
  const cur = currentVersion(ctx, item.memory_id);
  if (cur) prepared(ctx.db, "UPDATE memory_version SET expired_at = ? WHERE id = ?").run(iso(now), cur.id);
  prepared(ctx.db, "UPDATE memory SET status = 'forgotten', forgotten_at = ?, purge_after = ?, updated_at = ? WHERE id = ?")
    .run(iso(now), iso(now + purgeAfterDays * DAY_MS), iso(now), item.memory_id);
  return [item.memory_id];
}

/** A confirmation version at T0: same content and valid_from; the old version expires (data-model.md §6). */
function confirm(ctx: StoreContext, memoryId: string): string[] {
  const cur = currentVersion(ctx, memoryId);
  if (!cur || cur.trust_tier === 0) return [];
  prepared(ctx.db, "UPDATE memory_version SET expired_at = ? WHERE id = ?").run(iso(ctx.clock.now()), cur.id);
  const versionId = insertVersion(ctx, OWNER, memoryId, {
    content: cur.content, contentHash: cur.content_norm_hash, validFrom: cur.valid_from ?? undefined, tier: 0, changeKind: "confirmation", writeRequestKey: undefined,
  });
  // The confirmed text is unchanged, so its embedding moves to the new version.
  prepared(ctx.db, "INSERT OR REPLACE INTO embedding (owner_type, owner_id, model_id, dim, vector) SELECT 'version', ?, model_id, dim, vector FROM embedding WHERE owner_type = 'version' AND owner_id = ?")
    .run(versionId, cur.id);
  refreshFts(ctx, memoryId);
  return [memoryId];
}

/** A held memory becomes active at T0; as the owner's value it replaces other values of a `one` slot. */
function activateHeld(ctx: StoreContext, memoryId: string): string[] {
  const m = prepared(ctx.db, "SELECT m.status, m.entity_id, m.attribute_id, a.cardinality FROM memory m LEFT JOIN attribute a ON a.id = m.attribute_id WHERE m.id = ?")
    .get(memoryId) as { status: string; entity_id: string; attribute_id: string | null; cardinality: string | null } | undefined;
  if (m?.status !== "pending_review") return [];
  const touched = confirm(ctx, memoryId);
  setMemoryStatus(ctx, memoryId, "active");
  if (m.attribute_id && m.cardinality === "one") {
    const today = iso(ctx.clock.now()).slice(0, 10);
    const others = prepared(ctx.db, "SELECT id FROM memory WHERE entity_id = ? AND attribute_id = ? AND id != ? AND status IN ('active','contested')")
      .all(m.entity_id, m.attribute_id, memoryId) as { id: string }[];
    for (const o of others) {
      const v = currentVersion(ctx, o.id);
      if (v) prepared(ctx.db, "UPDATE memory_version SET valid_to = ?, valid_to_precision = 'day' WHERE id = ?").run(today, v.id);
      setMemoryStatus(ctx, o.id, "superseded", memoryId);
      prepared(ctx.db, "UPDATE memory_contest SET resolved_at = ?, resolution = 'kept_other' WHERE (memory_id = ? OR other_memory_id = ?) AND resolved_at IS NULL")
        .run(iso(ctx.clock.now()), o.id, o.id);
      refreshFts(ctx, o.id);
      touched.push(o.id);
    }
  }
  refreshFts(ctx, memoryId);
  return [...new Set([memoryId, ...touched])];
}
