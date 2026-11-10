// The event log (data-model.md §2, `event`): one row per change, holding ids only, chained by
// hash so that a removed or edited row breaks the chain. `meta.event_chain_head` holds the hash of
// the newest event. Events are written inside the same transaction as the change they record.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { iso } from "./clock.ts";
import type { StoreContext } from "./context.ts";

export const GENESIS_HASH = "0".repeat(64);

export interface EventInput {
  /** client_id, 'owner', 'job:<id>' or 'system'. */
  readonly actor: string;
  /** e.g. memory.insert, memory.update, memory.forget, section.create. */
  readonly op: string;
  /** Ids only, never content. */
  readonly refs: Record<string, unknown>;
  /** Ids and prior status or version pointers needed to undo; never content. */
  readonly undo?: Record<string, unknown>;
}

export function eventHash(prevHash: string, id: string, at: string, actor: string, op: string, refsJson: string, undoJson: string | null): string {
  return createHash("sha256").update(prevHash + id + at + actor + op + refsJson + (undoJson ?? ""), "utf8").digest("hex");
}

/** Appends one event and moves the chain head. Must run inside a write transaction. */
export function appendEvent({ db, clock, ids }: StoreContext, e: EventInput): string {
  const ms = clock.now();
  const id = ids.newId("evt", ms);
  const at = iso(ms);
  const refsJson = JSON.stringify(e.refs);
  const undoJson = e.undo === undefined ? null : JSON.stringify(e.undo);
  const head = db.prepare("SELECT value FROM meta WHERE key = 'event_chain_head'").get() as { value: string } | undefined;
  const prev = head?.value ?? GENESIS_HASH;
  const hash = eventHash(prev, id, at, e.actor, e.op, refsJson, undoJson);
  db.prepare("INSERT INTO event (id, at, actor, op, refs_json, undo_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, at, e.actor, e.op, refsJson, undoJson, prev, hash,
  );
  db.prepare("INSERT INTO meta(key, value) VALUES ('event_chain_head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  return id;
}

/** Recomputes the chain; returns the id of the first broken event, or undefined if intact. */
export function verifyEventChain(db: DatabaseSync): string | undefined {
  let prev = GENESIS_HASH;
  const rows = db.prepare("SELECT id, at, actor, op, refs_json, undo_json, prev_hash, hash FROM event ORDER BY id").all() as {
    id: string; at: string; actor: string; op: string; refs_json: string; undo_json: string | null; prev_hash: string; hash: string;
  }[];
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== eventHash(prev, r.id, r.at, r.actor, r.op, r.refs_json, r.undo_json)) return r.id;
    prev = r.hash;
  }
  return undefined;
}
