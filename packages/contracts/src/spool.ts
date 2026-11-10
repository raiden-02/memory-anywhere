// Spool record, format version 1 (topology-and-ipc.md §9). The client writes one file per entry
// in `{data}\spool\` when a write cannot reach the server; on drain each record becomes a
// `/v1/writes` Entry with `observed_at = spooled_at`. The file never holds unredacted text, and
// the server treats it as untrusted input: it assigns tier and source itself.

import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { CodingTool, PromptPayload, SavePayload, type EntryT } from "./schemas/v1.ts";

export const SPOOL_FORMAT_VERSION = 1;

const Base = {
  format_version: z.literal(SPOOL_FORMAT_VERSION),
  idempotency_key: z.string().regex(new RegExp(`^(spl|pxs)_${ULID_PATTERN}$`)),
  spooled_at: z.iso.datetime({ offset: true }),
  tool: CodingTool,
  repo_key: z.string(),
  session_id: z.string().max(128),
};

export const SpoolRecord = z.discriminatedUnion("op", [
  z.object({ ...Base, op: z.literal("prompt"), payload: PromptPayload }),
  z.object({ ...Base, op: z.literal("save"), payload: SavePayload }),
]);
export type SpoolRecordT = z.infer<typeof SpoolRecord>;

/** The `/v1/writes` entry a spool record is replayed as. */
export function spoolRecordToEntry(r: SpoolRecordT): EntryT {
  return {
    idempotency_key: r.idempotency_key,
    op: r.op,
    observed_at: r.spooled_at,
    tool: r.tool,
    repo_key: r.repo_key,
    session_id: r.session_id,
    payload: r.payload,
  };
}
