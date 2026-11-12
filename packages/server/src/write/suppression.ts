// Suppressions (write-path.md §9.2): after a forget or purge, the store keeps only an HMAC of the
// normalized text (and of the slot plus text for slotted memories), so the same thing is not saved
// again without the owner, and nothing readable remains. Matching checks the local key and every
// foreign key imported with another store's suppressions (data-model.md §10).

import { createHmac } from "node:crypto";
import { norm } from "@memory-anywhere/contracts/normalize";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared } from "../store/db.ts";

export function hmacHex(keyBase64: string, text: string): string {
  return createHmac("sha256", Buffer.from(keyBase64, "base64")).update(text, "utf8").digest("hex");
}

const slotText = (entityId: string, attributeId: string, content: string): string => `${entityId}|${attributeId}|${norm(content)}`;

interface Key {
  readonly keyId: string;
  readonly key: string;
}

function keys(ctx: StoreContext): Key[] {
  const local = prepared(ctx.db, "SELECT value FROM meta WHERE key = 'store_hmac_key'").get() as { value: string };
  const foreign = prepared(ctx.db, "SELECT key_id, key FROM foreign_suppression_key").all() as { key_id: string; key: string }[];
  return [{ keyId: "local", key: local.value }, ...foreign.map((f) => ({ keyId: f.key_id, key: f.key }))];
}

/** True when the text, or the slot filled with this text, was forgotten or purged. */
export function isSuppressed(ctx: StoreContext, content: string, slot: { entityId: string; attributeId: string } | undefined): boolean {
  const q = prepared(ctx.db, "SELECT 1 FROM suppression WHERE key_id = ? AND lifted_at IS NULL AND (hmac = ? OR (slot_hmac IS NOT NULL AND slot_hmac = ?)) LIMIT 1");
  return keys(ctx).some((k) => {
    const h = hmacHex(k.key, norm(content));
    const s = slot ? hmacHex(k.key, slotText(slot.entityId, slot.attributeId, content)) : "";
    return q.get(k.keyId, h, s) !== undefined;
  });
}

export function addSuppression(
  ctx: StoreContext, memoryId: string, content: string, slot: { entityId: string; attributeId: string } | undefined, reason: "forget" | "purge",
): string {
  const [local] = keys(ctx) as [Key];
  const id = ctx.ids.newId("sup", ctx.clock.now());
  prepared(ctx.db, "INSERT INTO suppression (id, hmac, slot_hmac, memory_id, key_id, reason, created_at) VALUES (?, ?, ?, ?, 'local', ?, ?)")
    .run(id, hmacHex(local.key, norm(content)), slot ? hmacHex(local.key, slotText(slot.entityId, slot.attributeId, content)) : null, memoryId, reason,
      iso(ctx.clock.now()));
  return id;
}

/** Lifts the local suppressions matching this text (an owner save, or a confirmed re-save). */
export function liftMatching(ctx: StoreContext, content: string, slot: { entityId: string; attributeId: string } | undefined): void {
  const [local] = keys(ctx) as [Key];
  const h = hmacHex(local.key, norm(content));
  const s = slot ? hmacHex(local.key, slotText(slot.entityId, slot.attributeId, content)) : "";
  prepared(ctx.db, "UPDATE suppression SET lifted_at = ? WHERE key_id = 'local' AND lifted_at IS NULL AND (hmac = ? OR slot_hmac = ?)")
    .run(iso(ctx.clock.now()), h, s);
}
