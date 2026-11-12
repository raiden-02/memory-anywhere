// Elicitation state between two rounds of one tool call (mcp-interface.md §5; MRTR, protocol
// revision 2026-07-28). When a save needs the person's yes/no, the tool answers "input required"
// with a question and an opaque `requestState`; the client asks the person and calls again with
// the answer and the same state.
//
//   requestState = base64url( nonce(12) ‖ AES-256-GCM_meta.mrtr_key( {v, grant_id, pending_id, args_sha256, exp} ) ‖ tag(16) )
//
// The retry is accepted only if the tag verifies, the grant is the caller's, the arguments hash
// to the same digest, the state is unexpired, and its pending_elicitation row is still unused
// (it is then consumed: single use). Anything else takes the "no answer" branch.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../auth/stepup.ts";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

export const ELICITATION_MS = 5 * 60_000;

const Payload = z.strictObject({ v: z.literal(1), grant_id: z.string(), pending_id: z.string(), args_sha256: z.string(), exp: z.int() });
type PayloadT = z.infer<typeof Payload>;

function key(ctx: StoreContext): Buffer {
  const v = (prepared(ctx.db, "SELECT value FROM meta WHERE key = 'mrtr_key'").get() as { value: string } | undefined)?.value;
  if (!v) throw new Error("meta.mrtr_key is missing");
  return Buffer.from(v, "base64"); // written as base64 at init and base64url after a restore; Node reads both
}

/** The digest a retry must repeat: the tool and its arguments, canonically ordered. */
export const argsDigest = (tool: string, args: unknown): string => createHash("sha256").update(canonicalJson({ tool, args })).digest("hex");

export function seal(ctx: StoreContext, p: PayloadT): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(ctx), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(p), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

/** The payload, or undefined for anything tampered, truncated or sealed under another key. */
export function open(ctx: StoreContext, state: string): PayloadT | undefined {
  try {
    const raw = Buffer.from(state, "base64url");
    if (raw.length < 12 + 16 + 2) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key(ctx), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    const parsed = Payload.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Starts an elicitation: the pending row (5 minutes) and the sealed state to hand the client. */
export function startElicitation(ctx: StoreContext, grantId: string, tool: string, argsSha256: string, question: string): string {
  const now = ctx.clock.now();
  const id = ctx.ids.newId("pel", now);
  prepared(ctx.db, "INSERT INTO pending_elicitation (id, grant_id, tool, args_sha256, question, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, grantId, tool, argsSha256, question, iso(now), iso(now + ELICITATION_MS));
  return seal(ctx, { v: 1, grant_id: grantId, pending_id: id, args_sha256: argsSha256, exp: Math.floor((now + ELICITATION_MS) / 1000) });
}

/** Checks a retry's state against the caller and its arguments, and consumes it. */
export function consumeElicitation(ctx: StoreContext, state: string, grantId: string, argsSha256: string): boolean {
  const p = open(ctx, state);
  const now = ctx.clock.now();
  if (!p || p.grant_id !== grantId || p.args_sha256 !== argsSha256 || p.exp * 1000 <= now) return false;
  const r = prepared(ctx.db, "UPDATE pending_elicitation SET consumed_at = ? WHERE id = ? AND grant_id = ? AND consumed_at IS NULL AND expires_at > ?")
    .run(iso(now), p.pending_id, grantId, iso(now));
  return Number(r.changes) === 1;
}
