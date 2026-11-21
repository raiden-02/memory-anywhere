// Internal API `/v1` (mcp-interface.md §7): request and response bodies. Every request carries
// `MA-Client-Version`; errors are an HTTP status plus the common `Error` object.

import { z } from "zod";
import { ULID_PATTERN } from "../ids.ts";
import { ErrorObject, Outcome, Timestamp } from "./common.ts";
import { RecallInput, SaveInput } from "./tools.ts";

export const CodingTool = z.enum(["claude-code", "codex", "cursor"]);
/** `rk_` + 32 hex characters (topology-and-ipc.md §8), or `none` outside an allowed repository. */
export const RepoKey = z.string().regex(/^(?:rk_[0-9a-f]{32}|none)$/);

export const HealthResponse = z.strictObject({
	ok: z.boolean(),
	version: z.string(),
	schema_version: z.int().min(0),
	policy_version: z.string(),
	min_client_version: z.string(),
});

export const SessionStartRequest = z.strictObject({
	tool: CodingTool,
	repo_key: RepoKey,
	session_id: z.string().min(1).max(128),
	max_chars: z.int().min(200).max(10000),
});

export const SessionStartResponse = z.strictObject({
	context: z.string(),
	profile_etag: z.string(),
	/** The rendered profile, so the client can refresh its offline cache. */
	profile: z.string().max(6000),
	repo_enabled: z.boolean(),
	capture_enabled: z.boolean(),
	policy_version: z.string(),
	notices: z.array(z.string()),
});

export const ProjectionResponse = z.strictObject({
	profile: z.string(),
	repo_context: z.string().nullable(),
	etag: z.string(),
	generated_at: Timestamp,
});

export const Entry = z.strictObject({
	idempotency_key: z.string().regex(new RegExp(`^(spl|pxs)_${ULID_PATTERN}$`)),
	op: z.enum(["prompt", "save", "forget"]),
	observed_at: z.iso.datetime({ offset: true }),
	tool: CodingTool.optional(),
	repo_key: z.string().optional(),
	session_id: z.string().max(128).optional(),
	payload: z.looseObject({}),
});

export const PromptPayload = z.strictObject({ prompt: z.string().max(8000) });
/** `memory_save` input without `supersedes` and `change` (a replay never supersedes). */
export const SavePayload = SaveInput.omit({ supersedes: true, change: true });
export const ForgetPayload = z.strictObject({ id: z.string(), reason: z.string().min(1).max(200) });

export const WritesRequest = z.strictObject({
	entries: z.array(Entry).min(1).max(100),
	dry_run: z.boolean().optional(),
});

export const WriteResult = z.strictObject({
	idempotency_key: z.string(),
	outcome: z.union([Outcome, z.enum(["forgotten", "already_forgotten"])]),
	reason: z.string(),
	id: z.string().optional(),
});

export const WritesResponse = z.strictObject({ results: z.array(WriteResult) });

export const RecallRequest = RecallInput.extend({ repo_key: RepoKey });

export const ReposCheckRequest = z.strictObject({ repo_key: RepoKey });
export const ReposCheckResponse = z.strictObject({
	enabled: z.boolean(),
	capture: z.boolean(),
	project: z.string().nullable(),
});

// ---- imports (importers.md, write-path.md §10.4–10.5)

/**
 * Every import source (importers.md §2). Atomic sources store each item as a memory; model-written
 * sources become observations; history and the vendors' prose memory summaries go through the
 * extractor (a summary's extracted facts are stored like an atomic list's items).
 */
export const ImportSourceType = z.enum([
	"claude-memory",
	"chatgpt-memory",
	"gemini-saved-info",
	"paste",
	"claude-user-md",
	"codex-user-md",
	"claude-code-auto-memory",
	"codex-memories",
	"chatgpt-history",
	"claude-history",
	"chatgpt-memory-summary",
	"gemini-memory-summary",
	"gemini-history",
]);

/** How the server treats an item: stored as given, or read by the extractor first. */
export const ImportItemMode = z.enum(["atomic", "extract"]);

/** One item of an upload. Content is redacted on the PC first (importers.md rule 4). */
export const ImportItem = z.strictObject({
	/** sha256(source_type ‖ source_item_id ‖ extractor_version ‖ ordinal), hex (rule 5). */
	key: z.string().regex(/^[0-9a-f]{64}$/),
	source_item_id: z.string().min(1).max(200),
	ordinal: z.int().min(0),
	mode: ImportItemMode,
	/** Atomic: the fact, ≤ 400 characters. */
	content: z.string().min(1).max(400).optional(),
	/** Extract: up to 20 of the owner's own messages from one conversation, or one summary section. */
	messages: z.array(z.string().min(1).max(4000)).min(1).max(20).optional(),
	/** The conversation (history) or file the item came from; the observation session key uses it. */
	group_id: z.string().min(1).max(200).optional(),
	/** When it was said (ISO date or date-time), for valid_from; never moves an observation's expiry. */
	date: z.string().max(40).optional(),
	/** A heading the item sat under, as a section hint. */
	section_hint: z.string().min(1).max(80).optional(),
});

export const ImportUploadRequest = z.strictObject({
	batch_id: z.string().regex(new RegExp(`^imb_${ULID_PATTERN}$`)),
	items: z.array(ImportItem).min(1).max(100),
});
export const ImportUploadResponse = z.strictObject({
	batch_id: z.string(),
	accepted: z.int().min(0),
	/** Items whose key the batch already recorded: a resumed or repeated upload. */
	already: z.int().min(0),
	/** Extraction items queued for the extractor. */
	queued: z.int().min(0),
});

/** Counts only, never content (importers.md §4: the report). */
export const ImportBatchStatus = z.strictObject({
	batch_id: z.string(),
	source_type: ImportSourceType,
	status: z.enum(["running", "done", "failed", "aborted_budget"]),
	pending: z.int().min(0),
	counts: z.record(z.string(), z.int().min(0)),
	cost_usd: z.number().min(0),
	estimate_usd: z.number().min(0),
	/** What the batch may spend: its cost before the last approval plus the whole dollars confirmed then. */
	budget_usd: z.number().min(0),
});

export const ImportEstimateRequest = z.strictObject({
	source_type: ImportSourceType,
	file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
	turns: z.int().min(0),
	chars: z.int().min(0),
	item_count: z.int().min(0),
	since: z.string().optional(),
	until: z.string().optional(),
});

export const ImportEstimateResponse = z.strictObject({
	estimate_usd: z.number().min(0),
	input_tokens: z.int().min(0),
	output_tokens: z.int().min(0),
	cache_hits: z.int().min(0),
	import_budget_remaining_usd: z.number(),
});

// ---- admin commands (config-and-cli.md §4.2). In aws mode each needs a step-up token for the
// command; in local mode the local token is the owner credential (topology-and-ipc.md §4).

export const AdminCommand = z.enum([
	"repo-enable",
	"repo-disable",
	"project-track",
	"project-add",
	"export",
	"import",
	"review",
]);

export const ProjectStatus = z.enum(["idea", "active", "paused", "shipped", "archived"]);

export const RepoEnableArgs = z.strictObject({
	repo_key: z.string().regex(/^rk_[0-9a-f]{32}$/),
	display_name: z.string().min(1).max(120),
	capture: z.boolean(),
	/** Present when the owner answered yes to "Track this repo as a project?". */
	track: z.strictObject({ name: z.string().min(1).max(80), repo_url: z.string().max(400).nullable() }).optional(),
});
export const RepoDisableArgs = z.strictObject({ repo_key: z.string().regex(/^rk_[0-9a-f]{32}$/) });
export const ProjectTrackArgs = z.strictObject({
	repo_key: z.string().regex(/^rk_[0-9a-f]{32}$/),
	name: z.string().min(1).max(80),
	repo_url: z.string().max(400).nullable(),
});
export const ProjectAddArgs = z.strictObject({
	name: z.string().min(1).max(80),
	aliases: z.array(z.string().min(1).max(80)).max(20),
	status: ProjectStatus.optional(),
	goal: z.string().min(1).max(400).optional(),
});
export const ReviewArgs = z.strictObject({
	approve: z.array(z.string().regex(new RegExp(`^rev_${ULID_PATTERN}$`))).max(100),
	reject: z.array(z.string().regex(new RegExp(`^rev_${ULID_PATTERN}$`))).max(100),
});
export const ExportArgs = z.strictObject({
	section: z.literal("projects").optional(),
	format: z.literal("json").optional(),
	include_auth: z.boolean(),
	recipient: z
		.string()
		.regex(/^age1[0-9a-z]{58}$/)
		.optional(),
});
/**
 * The step-up for an import (write-path.md §10.5 step 2): the approval page renders these with the
 * server's own estimate (from `chars`, as POST /v1/import/estimate computes it), the owner types that
 * estimate rounded up to whole dollars, and approving creates the batch the token is bound to, with
 * that many dollars as its budget. `estimate_usd` is the computer's figure, used only in local mode
 * (no approval page). A resume names the batch it continues; its file hash must match.
 */
export const ImportArgs = z.strictObject({
	source_type: ImportSourceType,
	file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
	item_count: z.int().min(1).max(1_000_000),
	estimate_usd: z.number().min(0),
	/** Characters of the items to upload (the dry run's count); needed for a history or summary. */
	chars: z.int().min(0).optional(),
	resume_batch_id: z
		.string()
		.regex(new RegExp(`^imb_${ULID_PATTERN}$`))
		.optional(),
});

export const ADMIN_ARGS = {
	"repo-enable": RepoEnableArgs,
	"repo-disable": RepoDisableArgs,
	"project-track": ProjectTrackArgs,
	"project-add": ProjectAddArgs,
	review: ReviewArgs,
	export: ExportArgs,
	import: ImportArgs,
} as const satisfies Record<z.infer<typeof AdminCommand>, z.ZodType>;

export const StepupRequest = z.strictObject({ command: AdminCommand, args: z.looseObject({}) });
export const StepupResponse = z.strictObject({
	request_id: z.string(),
	user_code: z.string(),
	approve_url: z.string(),
	expires_in: z.int(),
});

export const ApiError = ErrorObject;

export type HealthResponseT = z.infer<typeof HealthResponse>;
export type SessionStartRequestT = z.infer<typeof SessionStartRequest>;
export type SessionStartResponseT = z.infer<typeof SessionStartResponse>;
export type ProjectionResponseT = z.infer<typeof ProjectionResponse>;
export type EntryT = z.infer<typeof Entry>;
export type WritesRequestT = z.infer<typeof WritesRequest>;
export type WriteResultT = z.infer<typeof WriteResult>;
export type RecallRequestT = z.output<typeof RecallRequest>;
export type ReposCheckResponseT = z.infer<typeof ReposCheckResponse>;
export type AdminCommandT = z.infer<typeof AdminCommand>;
