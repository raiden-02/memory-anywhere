// Common definitions (mcp-interface.md §2), shared by the tool and /v1 schemas. The committed JSON
// Schemas in packages/contracts/schema/ are generated from these by `pnpm gen`.

import { z } from "zod";
import { ULID_PATTERN } from "../ids.ts";

export const MemoryId = z.string().regex(new RegExp(`^mem_${ULID_PATTERN}$`));
export const ObservationId = z.string().regex(new RegExp(`^obs_${ULID_PATTERN}$`));
export const Kind = z.enum(["fact", "preference", "instruction", "event"]);
export const Outcome = z.enum(["active", "observation", "review", "rejected", "queued"]);
export const Tier = z.enum(["T0", "T1", "T2", "T3"]);
export const PartialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/);
export const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Timestamp = z.iso.datetime({ offset: true });
export const ErrorCode = z.enum([
  "INVALID_INPUT", "UNAUTHORIZED", "FORBIDDEN", "READ_ONLY_CLIENT", "REPO_NOT_ENABLED", "NOT_FOUND",
  "RATE_LIMITED", "STORE_UNAVAILABLE", "CLIENT_TOO_OLD", "INTERNAL",
]);

export const ErrorObject = z.strictObject({
  code: ErrorCode,
  message: z.string().max(300),
  field: z.string().optional(),
  retry_after_s: z.int().min(1).optional(),
});

export const RecallItem = z.strictObject({
  id: MemoryId,
  kind: Kind,
  entity: z.string(),
  section: z.string(),
  attribute: z.string().nullable().optional(),
  content: z.string().max(400),
  valid_from: z.string().nullable().optional(),
  valid_to: z.string().nullable().optional(),
  recorded_at: Timestamp,
  tier: Tier,
  status: z.enum(["active", "contested", "superseded"]),
  contested_with: z.array(MemoryId).optional(),
  via: z.string().describe("display name of the client of the first source"),
  expires_at: z.string().nullable().optional(),
});

export type MemoryIdT = z.infer<typeof MemoryId>;
export type KindT = z.infer<typeof Kind>;
export type OutcomeT = z.infer<typeof Outcome>;
export type TierT = z.infer<typeof Tier>;
export type ErrorCodeT = z.infer<typeof ErrorCode>;
export type ErrorObjectT = z.infer<typeof ErrorObject>;
export type RecallItemT = z.infer<typeof RecallItem>;
