// The five MCP tools (mcp-interface.md §3): input and output schemas, titles and annotations.
// Descriptions are policy texts (memory-policy.md §6) and are attached by the server from the
// generated policy files. `tools/list` uses TOOL_ORDER.

import { z } from "zod";
import {
  DateString, Kind, MemoryId, ObservationId, Outcome, PartialDate, RecallItem, Tier, Timestamp,
} from "./common.ts";

// ---- memory_recall

export const RecallInput = z.strictObject({
  query: z.string().min(1).max(300),
  section: z.string().max(32).describe("Narrow to one section by name, e.g. Preferences").optional(),
  scope: z.enum(["any", "global", "repo"]).default("any"),
  kinds: z.array(Kind).max(4).meta({ uniqueItems: true }).optional(),
  as_of: DateString.optional(),
  limit: z.int().min(1).max(10).default(6),
});

export const RecallOutput = z.strictObject({
  notice: z.string(),
  items: z.array(RecallItem).max(12),
  truncated: z.boolean(),
  budget_exhausted: z.boolean(),
  offline: z.boolean(),
  generated_at: Timestamp.optional(),
});

// ---- memory_profile

export const ProfileInput = z.strictObject({});

export const ProfileOutput = z.strictObject({
  notice: z.string(),
  policy_version: z.string(),
  profile_etag: z.string().regex(/^[0-9a-f]{64}$/),
  text: z.string().max(6000),
  sections: z.array(z.string()),
  owner_preferences: z.array(RecallItem),
  pinned: z.array(RecallItem),
  key_facts: z.array(RecallItem),
  pending_review_count: z.int().min(0),
  offline: z.boolean().optional(),
});

// ---- memory_save

export const SaveInput = z.strictObject({
  content: z.string().min(1).max(400),
  kind: Kind,
  why_durable: z.string().min(1).max(200),
  user_words: z.string().max(200).optional(),
  explicit_request: z.boolean().default(false),
  section: z.string().max(32).optional(),
  entity: z.string().max(80).default("self"),
  attribute: z.string().max(48).optional(),
  scope: z.enum(["global", "repo"]).default("global"),
  supersedes: MemoryId.optional(),
  change: z.enum(["update", "correction"]).default("update"),
  valid_from: PartialDate.optional(),
  expires_on: DateString.optional(),
  policy_version: z.string().max(16).optional(),
});

export const SaveOutput = z.strictObject({
  outcome: Outcome,
  reason: z.string(),
  message: z.string().max(300),
  // The two branches are disjoint, so the generated schema says `oneOf` (json-schema.ts).
  id: z.union([MemoryId, ObservationId]).meta({ "x-exclusive": true }).optional(),
  tier: Tier.optional(),
  section: z.string().optional(),
  memory_status: z.enum(["active", "contested", "pending_review", "superseded"]).optional(),
  contested_with: z.array(MemoryId).optional(),
  idempotency_key: z.string().optional(),
  policy_version: z.string(),
});

// ---- memory_forget

export const ForgetInput = z.strictObject({
  id: MemoryId,
  reason: z.string().min(1).max(200),
});

export const ForgetOutput = z.strictObject({
  id: MemoryId,
  outcome: z.enum(["forgotten", "review", "already_forgotten"]),
  message: z.string(),
  undo_until: Timestamp.optional(),
});

// ---- memory_status

export const StatusInput = z.strictObject({});

export const StatusOutput = z.strictObject({
  store: z.enum(["aws", "local", "offline"]),
  health: z.enum(["ok", "degraded", "offline"]),
  degraded_reasons: z.array(z.enum(["llm_unavailable", "llm_cap", "backup_lag", "disk_low", "jobs_failing"])).optional(),
  client: z.strictObject({
    name: z.string(),
    class: z.enum(["chat", "coding"]),
    read: z.boolean(),
    write: z.boolean(),
    repo_enabled: z.boolean().nullable().optional(),
  }),
  counts_order_of_magnitude: z
    .strictObject({ memories: z.enum(["0", "1-9", "10-99", "100-999", "1000+"]).optional() })
    .optional(),
  policy_version_server: z.string(),
  policy_version_reported: z.string(),
  server_version: z.string(),
  warnings: z.array(z.string().max(200)).optional(),
  last_contact_at: Timestamp.optional(),
  spool_count: z.int().optional(),
});

// ---- registry

export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: boolean;
}

export const TOOL_ORDER = ["memory_recall", "memory_profile", "memory_save", "memory_forget", "memory_status"] as const;
export type ToolName = (typeof TOOL_ORDER)[number];

/** Tools that change the store; omitted from `tools/list` for a client with `write = 0`. */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set(["memory_save", "memory_forget"]);

export const TOOLS = {
  memory_recall: {
    input: RecallInput,
    output: RecallOutput,
    annotations: { title: "Recall memories", readOnlyHint: true, openWorldHint: false },
  },
  memory_profile: {
    input: ProfileInput,
    output: ProfileOutput,
    annotations: { title: "Load profile", readOnlyHint: true, openWorldHint: false },
  },
  memory_save: {
    input: SaveInput,
    output: SaveOutput,
    annotations: { title: "Save a memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  memory_forget: {
    input: ForgetInput,
    output: ForgetOutput,
    annotations: { title: "Forget a memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  memory_status: {
    input: StatusInput,
    output: StatusOutput,
    annotations: { title: "Memory status", readOnlyHint: true, openWorldHint: false },
  },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType; annotations: ToolAnnotations }>;

/** Request `_meta` key for the proxy's idempotency key (honoured for class `coding` only). */
export const IDEMPOTENCY_META_KEY = "memory-anywhere/idempotency_key";

export type RecallInputT = z.output<typeof RecallInput>;
export type RecallOutputT = z.infer<typeof RecallOutput>;
export type ProfileOutputT = z.infer<typeof ProfileOutput>;
export type SaveInputT = z.output<typeof SaveInput>;
export type SaveOutputT = z.infer<typeof SaveOutput>;
export type ForgetInputT = z.output<typeof ForgetInput>;
export type ForgetOutputT = z.infer<typeof ForgetOutput>;
export type StatusOutputT = z.infer<typeof StatusOutput>;
