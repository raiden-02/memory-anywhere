// Imports (importers.md; write-path.md §10.2, §10.4, §10.5): what the owner's other apps already
// know, uploaded by `mema import` after one step-up per batch.
//
//   step-up approved (or local mode: the local token) ─► createBatch: one import_batch per approval
//   POST /v1/admin/import {batch_id, items ≤ 100}     ─► upload: each key recorded once (import_item)
//       atomic item  ─► save() now, channel import, T3
//       extract item ─► kept redacted in import_item.input_json, one `extract` job queued
//   job extract      ─► the extractor (purpose import) ─► span check ─► save() per fact ─► input dropped
//   at the batch's budget (the dollars the owner confirmed) or import_usd_cap
//                    ─► batch `aborted_budget`; items stay queued; a resume (a new approval) queues them again
//   GET /v1/import/batches/<id> ─► counts only, never content
//
// Every save goes through the write path, so the screens, suppressions and store rules apply as for
// any app; the import channel's own rows are in decide.ts. Imports make no per-item LLM call: the
// extractor is the only model call, spent from the import budget the owner confirmed.

import { createHash } from "node:crypto";
import { contentWords, norm, normEntity } from "@memory-anywhere/contracts/normalize";
import { redact } from "@memory-anywhere/contracts/redact";
import type { z } from "zod";
import type {
	ImportArgs,
	ImportBatchStatus,
	ImportEstimateRequest,
	ImportEstimateResponse,
	ImportItem,
	ImportSourceType,
	ImportUploadResponse,
} from "@memory-anywhere/contracts/schemas/v1";
import type { Llm } from "../llm/adapter.ts";
import { priceOf } from "../llm/adapter.ts";
import { EXTRACT_PROMPT_TOKENS, EXTRACT_PROMPT_VERSION, extractCall, type ExtractOutputT } from "../llm/prompts.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { ImportClass } from "./decide.ts";
import { save, type WriteEnv } from "./pipeline.ts";
import { WriteError, type Caller, type SaveRequest } from "./types.ts";
import { support } from "./verify.ts";

type SourceType = z.infer<typeof ImportSourceType>;
type Item = z.infer<typeof ImportItem>;

/** The writer of every import: not an app, so an import neither counts against an app's limits nor is undone with it. */
export const IMPORT_CLIENT_ID = "cli_import";

/** importers.md §2: which sources are memories and which are observations (needing recurrence). */
export const SOURCE_CLASS: Readonly<Record<SourceType, ImportClass>> = {
	"claude-memory": "memory",
	"chatgpt-memory": "memory",
	"gemini-saved-info": "memory",
	paste: "memory",
	"claude-user-md": "memory",
	"codex-user-md": "memory",
	// The vendors' memories in prose: read by the extractor, stored like their lists.
	"chatgpt-memory-summary": "memory",
	"gemini-memory-summary": "memory",
	// Coding tools write these after reading web and tool output: storing them directly would launder injections.
	"claude-code-auto-memory": "observation",
	"codex-memories": "observation",
	"chatgpt-history": "observation",
	"claude-history": "observation",
	"gemini-history": "observation",
};

/** Sources whose items are read by the extractor, so the estimate counts model calls for them. */
export const EXTRACTED: ReadonlySet<SourceType> = new Set([
	"chatgpt-history",
	"claude-history",
	"gemini-history",
	"chatgpt-memory-summary",
	"gemini-memory-summary",
]);

/** Batch statuses (data-model.md import_batch). */
type BatchStatus = z.infer<typeof ImportBatchStatus>["status"];

interface BatchRow {
	readonly id: string;
	readonly source_type: SourceType;
	readonly file_sha256: string;
	readonly status: BatchStatus;
	readonly counts_json: string;
	readonly cost_usd: number;
	readonly item_count: number;
	readonly estimate_usd: number;
	readonly budget_usd: number;
}

/** What an extract item keeps until the extractor reads it. */
interface ExtractInput {
	readonly messages: readonly string[];
	readonly group: string;
	readonly saidAt: number | undefined;
	readonly sectionHint: string | undefined;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function batchRow(ctx: StoreContext, id: string): BatchRow | undefined {
	return prepared(
		ctx.db,
		"SELECT id, source_type, file_sha256, status, counts_json, cost_usd, item_count, estimate_usd, budget_usd FROM import_batch WHERE id = ?",
	).get(id) as BatchRow | undefined;
}

/** Adds `n` to one count of the batch's report, in one statement (uploads may interleave). */
function bump(ctx: StoreContext, batchId: string, key: string, n = 1): void {
	if (n === 0) return;
	const path = `$."${key}"`;
	prepared(
		ctx.db,
		"UPDATE import_batch SET counts_json = json_set(counts_json, ?, coalesce(json_extract(counts_json, ?), 0) + ?) WHERE id = ?",
	).run(path, path, n, batchId);
}

// ---- batches

export type BatchResult =
	{ readonly ok: true; readonly batchId: string } | { readonly ok: false; readonly message: string };

/**
 * Checks that a resume continues a batch of the same file; nothing changes. The step-up request
 * calls it before the owner sees the approval page, and again when approved.
 */
export function checkResume(ctx: StoreContext, a: z.infer<typeof ImportArgs>): string | undefined {
	if (!a.resume_batch_id) return undefined;
	const b = batchRow(ctx, a.resume_batch_id);
	if (!b) return "no import batch with that id";
	if (b.file_sha256 !== a.file_sha256 || b.source_type !== a.source_type) return "that batch imported a different file";
	return undefined;
}

/**
 * The batch an approved import writes to (write-path.md §10.5 step 2): a new one, or the batch it
 * resumes, which runs again and gets its waiting items queued again. Its budget is what it has spent
 * so far plus the approved estimate in whole dollars, rounded up: the amount the owner typed (in
 * local mode, the computer's estimate).
 */
export function createBatch(ctx: StoreContext, a: z.infer<typeof ImportArgs>): BatchResult {
	const wrong = checkResume(ctx, a);
	if (wrong) return { ok: false, message: wrong };
	return transaction(ctx.db, () => {
		const now = ctx.clock.now();
		if (a.resume_batch_id) {
			prepared(
				ctx.db,
				`UPDATE import_batch SET status = 'running', finished_at = NULL, item_count = max(item_count, ?), estimate_usd = ?, budget_usd = cost_usd + ?
          WHERE id = ?`,
			).run(a.item_count, a.estimate_usd, confirmDollars(a.estimate_usd), a.resume_batch_id);
			requeue(ctx, a.resume_batch_id);
			appendEvent(ctx, { actor: "owner", op: "import.resume", refs: { batch_id: a.resume_batch_id } });
			return { ok: true, batchId: a.resume_batch_id };
		}
		const id = ctx.ids.newId("imb", now);
		prepared(
			ctx.db,
			`INSERT INTO import_batch (id, source_type, file_sha256, dry_run, started_at, status, item_count, estimate_usd, budget_usd)
      VALUES (?, ?, ?, 0, ?, 'running', ?, ?, ?)`,
		).run(id, a.source_type, a.file_sha256, iso(now), a.item_count, a.estimate_usd, confirmDollars(a.estimate_usd));
		appendEvent(ctx, { actor: "owner", op: "import.start", refs: { batch_id: id, source_type: a.source_type } });
		return { ok: true, batchId: id };
	});
}

/** Queues an extract job for each of the batch's waiting items that has none. */
function requeue(ctx: StoreContext, batchId: string): void {
	const waiting = prepared(
		ctx.db,
		`SELECT i.idempotency_key k FROM import_item i WHERE i.batch_id = ? AND i.outcome = 'queued'
      AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = 'extract' AND j.status IN ('queued','running') AND json_extract(j.payload_json, '$.import_item_key') = i.idempotency_key)`,
	).all(batchId) as { k: string }[];
	for (const w of waiting) queueExtract(ctx, w.k);
}

function queueExtract(ctx: StoreContext, key: string): void {
	const now = ctx.clock.now();
	prepared(
		ctx.db,
		"INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, 'extract', ?, 0, ?, 'queued', ?)",
	).run(ctx.ids.newId("job", now), JSON.stringify({ import_item_key: key }), iso(now), iso(now));
}

/** Items waiting for the extractor. */
function pendingCount(ctx: StoreContext, batchId: string): number {
	return (
		prepared(ctx.db, "SELECT count(*) n FROM import_item WHERE batch_id = ? AND outcome = 'queued'").get(batchId) as {
			n: number;
		}
	).n;
}

/**
 * A running batch is done once nothing waits for the extractor and the approved number of items
 * has arrived (recorded here, or already recorded by an earlier import of the same file).
 */
function finishIfDone(ctx: StoreContext, batchId: string): void {
	const b = batchRow(ctx, batchId);
	if (b?.status !== "running" || pendingCount(ctx, batchId) > 0) return;
	const recorded = (
		prepared(ctx.db, "SELECT count(*) n FROM import_item WHERE batch_id = ?").get(batchId) as { n: number }
	).n;
	const already = (JSON.parse(b.counts_json) as Record<string, number>)["items.already"] ?? 0;
	if (recorded + already < b.item_count) return;
	prepared(ctx.db, "UPDATE import_batch SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running'").run(
		iso(ctx.clock.now()),
		batchId,
	);
}

/** GET /v1/import/batches/<id>: counts only (importers.md §5). */
export function batchStatus(ctx: StoreContext, batchId: string): z.infer<typeof ImportBatchStatus> | undefined {
	const b = batchRow(ctx, batchId);
	if (!b) return undefined;
	return {
		batch_id: b.id,
		source_type: b.source_type,
		status: b.status,
		pending: pendingCount(ctx, b.id),
		counts: JSON.parse(b.counts_json) as Record<string, number>,
		cost_usd: b.cost_usd,
		estimate_usd: b.estimate_usd,
		budget_usd: b.budget_usd,
	};
}

// ---- upload

/** Atomic items carry no kind (importers.md §2): a line stating a liking or a wish is a preference. */
const PREFERENCE_START = /^(?:prefers?|likes|dislikes|loves|hates|enjoys|wants|would rather)\b/u;
export const atomicKind = (content: string): "fact" | "preference" =>
	PREFERENCE_START.test(norm(content)) ? "preference" : "fact";

/** An ISO date or date-time from the PC, as a time no later than now; anything else is ignored. */
function saidAtOf(date: string | undefined, now: number): number | undefined {
	if (!date || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(date)) return undefined;
	const t = Date.parse(date);
	return Number.isNaN(t) ? undefined : Math.min(t, now);
}

/** Checks each item has what its mode needs; returns the first problem as a field path. */
export function checkItems(items: readonly Item[]): { field: string; message: string } | undefined {
	for (const [i, it] of items.entries()) {
		if (it.mode === "atomic" && it.content === undefined)
			return { field: `items.${i}.content`, message: "an atomic item needs content" };
		if (it.mode === "extract" && it.messages === undefined)
			return { field: `items.${i}.messages`, message: "an extract item needs messages" };
	}
	return undefined;
}

/** Observation session key (write-path.md §10.4): one per conversation or file of the batch. */
const sessionKey = (batchId: string, it: Pick<Item, "group_id" | "source_item_id">): string =>
	`import:${batchId}:${it.group_id ?? it.source_item_id}`;

function importCaller(
	batchId: string,
	source: SourceType,
	it: Pick<Item, "group_id" | "source_item_id" | "key">,
): Caller {
	return {
		clientId: IMPORT_CLIENT_ID,
		clientClass: "coding",
		channel: "import",
		tier: 3,
		sessionKey: sessionKey(batchId, it),
		repoKey: undefined,
		tool: source,
		floored: false,
		canElicit: false,
		elicitationAnswer: undefined,
		importItemKey: it.key,
	};
}

/** Records an item once; false when its key was recorded meanwhile (two uploads of one item at the same time). */
function recordItem(
	ctx: StoreContext,
	batchId: string,
	source: SourceType,
	it: Item,
	o: { outcome: string; reason: string; id?: string | undefined; input?: ExtractInput },
): boolean {
	const r = prepared(
		ctx.db,
		`INSERT INTO import_item (idempotency_key, batch_id, source_type, source_item_id, extractor_version, ordinal, outcome, reason, memory_id, observation_id, input_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
	).run(
		it.key,
		batchId,
		source,
		it.source_item_id,
		it.mode === "extract" ? EXTRACT_PROMPT_VERSION : "atomic",
		it.ordinal,
		o.outcome,
		o.reason,
		o.id?.startsWith("mem_") ? o.id : null,
		o.id?.startsWith("obs_") ? o.id : null,
		o.input ? JSON.stringify(o.input) : null,
	);
	return Number(r.changes) === 1;
}

/**
 * POST /v1/admin/import (write-path.md §10.5 step 3). Each item is recorded once by its key, in this
 * batch or an earlier one, so a repeated or resumed upload changes nothing. Throws NOT_FOUND for an
 * unknown batch, and INVALID_INPUT, recording nothing, when an item's mode does not fit the batch's
 * source (importers.md §2): an extract item in a list's batch would spend the import budget the
 * owner approved as $0, and an atomic item in a history's or summary's batch would skip the span check.
 */
export async function upload(
	env: WriteEnv,
	batchId: string,
	items: readonly Item[],
): Promise<z.infer<typeof ImportUploadResponse>> {
	const { ctx } = env;
	const b = batchRow(ctx, batchId);
	if (!b) throw new WriteError("NOT_FOUND", "no import batch with that id", "batch_id");
	const mode = EXTRACTED.has(b.source_type) ? "extract" : "atomic";
	const misfit = items.findIndex((it) => it.mode !== mode);
	if (misfit >= 0)
		throw new WriteError(
			"INVALID_INPUT",
			`items of ${b.source_type} are uploaded in mode ${mode}`,
			`items.${misfit}.mode`,
		);
	const cls = SOURCE_CLASS[b.source_type];
	let accepted = 0;
	let already = 0;
	let queued = 0;
	for (const it of items) {
		if (prepared(ctx.db, "SELECT 1 FROM import_item WHERE idempotency_key = ?").get(it.key)) {
			already++;
			continue;
		}
		const now = ctx.clock.now();
		const saidAt = saidAtOf(it.date, now);
		if (it.mode === "extract") {
			// The PC redacted the messages (importers.md rule 4); the server redacts again before keeping them.
			const input: ExtractInput = {
				messages: (it.messages ?? []).map((m) => redact(m).text),
				group: it.group_id ?? it.source_item_id,
				saidAt,
				sectionHint: it.section_hint,
			};
			const fresh = transaction(ctx.db, () => {
				if (!recordItem(ctx, batchId, b.source_type, it, { outcome: "queued", reason: "queued", input })) return false;
				queueExtract(ctx, it.key);
				return true;
			});
			if (fresh) {
				accepted++;
				queued++;
			} else already++;
			continue;
		}
		const content = redact(it.content ?? "").text;
		const r = await saveImported(env, batchId, b.source_type, cls, it, {
			key: it.key,
			content,
			kind: atomicKind(content),
			userWords: undefined,
			entity: "self",
			attribute: undefined,
			saidAt,
		});
		if (!transaction(ctx.db, () => recordItem(ctx, batchId, b.source_type, it, r))) {
			already++;
			continue;
		}
		bump(ctx, batchId, `${r.outcome}.${r.reason}`);
		accepted++;
	}
	bump(ctx, batchId, "items.accepted", accepted);
	bump(ctx, batchId, "items.already", already);
	transaction(ctx.db, () => {
		// More items than approved arrived after the batch finished: it runs until they are extracted.
		if (queued > 0)
			prepared(
				ctx.db,
				"UPDATE import_batch SET status = 'running', finished_at = NULL WHERE id = ? AND status = 'done'",
			).run(batchId);
		finishIfDone(ctx, batchId);
	});
	return { batch_id: batchId, accepted, already, queued };
}

interface Proposal {
	readonly key: string;
	readonly content: string;
	readonly kind: "fact" | "preference" | "event";
	readonly userWords: string | undefined;
	readonly entity: string;
	readonly attribute: string | undefined;
	readonly saidAt: number | undefined;
}

/** One proposal through the write path at T3; an item the path refuses as invalid is recorded as rejected. */
async function saveImported(
	env: WriteEnv,
	batchId: string,
	source: SourceType,
	cls: ImportClass,
	it: Item,
	p: Proposal,
	sectionHint = it.section_hint,
): Promise<{ outcome: string; reason: string; id?: string | undefined }> {
	// A secret redacted on the PC leaves a marker: the item is not stored (row D1).
	if (p.content.includes("[REDACTED:")) return { outcome: "rejected", reason: "secret" };
	const req: SaveRequest = {
		content: p.content,
		kind: p.kind,
		why_durable: `imported from ${source}`,
		user_words: p.userWords,
		explicit_request: false,
		entity: p.entity,
		section: sectionHint,
		scope: "global",
		change: "update",
		valid_from: p.saidAt === undefined ? undefined : iso(p.saidAt).slice(0, 10),
	};
	try {
		const r = await save(env, importCaller(batchId, source, it), req, {
			idempotencyKey: p.key,
			observedAt: env.ctx.clock.now(),
			import: { batchId, class: cls, proposedAttribute: p.attribute, saidAt: p.saidAt },
		});
		if (r.kind !== "result") return { outcome: "rejected", reason: "input_required" };
		return { outcome: r.outcome.outcome, reason: r.outcome.reason, id: r.outcome.id };
	} catch (e) {
		if (e instanceof WriteError && e.code === "INVALID_INPUT") return { outcome: "rejected", reason: "invalid_input" };
		throw e;
	}
}

// ---- the bulk approval of sensitive items (write-path.md §10.4)

const words = (text: string): string[] =>
	normEntity(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w !== "");

/**
 * Which held items name someone else: a test on an item's text that is true when it contains, as
 * whole words, an approved alias of a known person (an active `person` entity, the same aliases the
 * write path resolves names with). A list item is always saved about the owner, so D3 cannot see
 * that "Sam from work is in rehab" is about Sam; such an item stays in review, but outside the
 * import's "Approve all", for the owner to decide one by one. People the store does not know yet
 * are not found.
 */
export function namesKnownPerson(ctx: StoreContext): (content: string) => boolean {
	const aliases = (
		prepared(
			ctx.db,
			`SELECT DISTINCT a.alias_norm FROM entity_alias a JOIN entity e ON e.id = a.entity_id
      WHERE a.approved = 1 AND e.type = 'person' AND e.status = 'active'`,
		).all() as { alias_norm: string }[]
	)
		.map((a) => words(a.alias_norm))
		.filter((a) => a.length > 0);
	return (content) => {
		const text = words(content);
		return aliases.some((alias) => text.some((_, i) => alias.every((w, j) => text[i + j] === w)));
	};
}

/** An import's open sensitive items, split into those the bulk approval takes and those that name someone else. */
export function heldSensitive(ctx: StoreContext, batchId: string): { bulk: string[]; oneByOne: string[] } {
	const named = namesKnownPerson(ctx);
	const items = prepared(
		ctx.db,
		`SELECT r.id, coalesce(v.content, '') content FROM review_item r
      LEFT JOIN memory_version v ON v.id = (SELECT max(id) FROM memory_version WHERE memory_id = r.memory_id)
    WHERE r.kind = 'import_sensitive' AND r.resolved_at IS NULL AND json_extract(r.payload_json, '$.batch_id') = ? ORDER BY r.id`,
	).all(batchId) as { id: string; content: string }[];
	return {
		bulk: items.filter((i) => !named(i.content)).map((i) => i.id),
		oneByOne: items.filter((i) => named(i.content)).map((i) => i.id),
	};
}

// ---- extraction

/**
 * Why the span check dropped an extracted item, or undefined when it passes (write-path.md §10.2).
 * The span must be the owner's words, verbatim, from one of the call's messages (the model
 * sometimes cites the wrong message id), and the fact's content words must come from the call's
 * messages taken together, since a fact often joins what two messages of one conversation say.
 */
export function spanCheck(
	item: ExtractOutputT["items"][number],
	messages: readonly string[],
	supportMin: number,
): "unsupported_span" | "low_support" | "redacted" | "too_long" | undefined {
	if (item.content.includes("[REDACTED:") || item.span.includes("[REDACTED:")) return "redacted";
	if ([...item.content].length > 400 || item.content.trim() === "") return "too_long";
	const span = norm(item.span);
	if ([...item.span.trim()].length < 8 || span === "" || !messages.some((m) => norm(m).includes(span)))
		return "unsupported_span";
	if (contentWords(item.content).length === 0 || support(messages.join("\n"), item.content) < supportMin)
		return "low_support";
	return undefined;
}

/** Thrown to retry an extract job: the model timed out or answered with an error. */
export class ExtractRetry extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`extract ${code}`);
		this.name = "ExtractRetry";
		this.code = code;
	}
}

/** The worker's retries for one job (jobs/worker.ts): after the last, the item is recorded as failed. */
const LAST_ATTEMPT = 3;

/**
 * The `extract` job of one import item. Returns the memories it touched. At the batch's own budget,
 * or at the import budget of all batches, the batch stops (`aborted_budget`) and the item stays
 * queued for a resume; with no model (provider none, or no key) the batch fails the same way. A
 * timeout or error is retried by the worker. The call counts against the batch's budget in the
 * adapter, which holds each waiting call's worst case, so extract jobs of one batch running side by
 * side never pass it together; what a call cost is added to the batch as the adapter records it.
 */
export async function runImportExtract(env: WriteEnv, llm: Llm, key: string, attempts: number): Promise<void> {
	const { ctx } = env;
	const row = prepared(
		ctx.db,
		"SELECT batch_id, source_item_id, ordinal, outcome, input_json FROM import_item WHERE idempotency_key = ?",
	).get(key) as
		| { batch_id: string; source_item_id: string; ordinal: number; outcome: string; input_json: string | null }
		| undefined;
	if (!row) return;
	if (row.outcome !== "queued" || !row.input_json) {
		// Recorded meanwhile (a purge drops a waiting item's messages): the batch may be done now.
		transaction(ctx.db, () => finishIfDone(ctx, row.batch_id));
		return;
	}
	const b = batchRow(ctx, row.batch_id);
	if (!b) return;
	const input = JSON.parse(row.input_json) as ExtractInput;
	const call = extractCall(input.messages);
	const answer = await llm.ask(call, "import", {
		key: b.id,
		usd: b.budget_usd,
		spent: () => batchRow(ctx, b.id)?.cost_usd ?? 0,
		record: (usd) => prepared(ctx.db, "UPDATE import_batch SET cost_usd = cost_usd + ? WHERE id = ?").run(usd, b.id),
	});
	if (!answer.ok) {
		if (answer.why === "cap" || answer.why === "budget" || answer.why === "off" || answer.why === "no_key") {
			const status: BatchStatus = answer.why === "cap" || answer.why === "budget" ? "aborted_budget" : "failed";
			prepared(ctx.db, "UPDATE import_batch SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(
				status,
				iso(ctx.clock.now()),
				b.id,
			);
			return;
		}
		if (attempts < LAST_ATTEMPT) throw new ExtractRetry(answer.why);
		transaction(ctx.db, () => {
			prepared(
				ctx.db,
				"UPDATE import_item SET outcome = 'failed', reason = ?, input_json = NULL WHERE idempotency_key = ?",
			).run(`extract_${answer.why}`, key);
			bump(ctx, b.id, `failed.extract_${answer.why}`);
			finishIfDone(ctx, b.id);
		});
		throw new ExtractRetry(answer.why);
	}
	bump(ctx, b.id, answer.usd > 0 ? "extract.calls" : "extract.cached");

	const cls = SOURCE_CLASS[b.source_type];
	const item: Item = {
		key,
		source_item_id: row.source_item_id,
		ordinal: row.ordinal,
		mode: "extract",
		group_id: input.group,
		section_hint: input.sectionHint,
	};
	let facts = 0;
	for (const [ordinal, x] of answer.value.items.entries()) {
		const dropped = spanCheck(x, input.messages, env.config.write.capture_support_min);
		if (dropped) {
			bump(ctx, b.id, `extract.${dropped}`);
			continue;
		}
		// Each fact has its own write key, so a job that ran halfway gives the same results when it runs again.
		const r = await saveImported(
			env,
			b.id,
			b.source_type,
			cls,
			item,
			{
				key: sha256([key, call.promptVersion, String(ordinal)].join("\n")),
				content: x.content.trim(),
				kind: x.kind,
				userWords: [...x.span.trim()].slice(0, 200).join(""),
				entity: x.entity?.trim() || "self",
				attribute: x.attribute ?? undefined,
				saidAt: input.saidAt,
			},
			x.section?.trim() || undefined,
		);
		bump(ctx, b.id, `${r.outcome}.${r.reason}`);
		facts++;
	}
	transaction(ctx.db, () => {
		prepared(
			ctx.db,
			"UPDATE import_item SET outcome = 'extracted', reason = ?, input_json = NULL WHERE idempotency_key = ?",
		).run(facts > 0 ? "extracted" : "nothing_extracted", key);
		bump(ctx, b.id, "extract.facts", facts);
		finishIfDone(ctx, b.id);
	});
}

// ---- estimate

/**
 * What one extractor call costs beyond the messages' own tokens, calibrated on a reference import of
 * 145 calls over 302,000 characters (≈ 257,000 input and 28,000 output tokens). Input: the instructions plus the structured-output schema the provider adds to each call
 * (≈ 1,250 tokens a call, of which the instructions were 350). Output: the JSON of
 * the facts found, ≈ 190 tokens a call, little of which depends on the messages' length.
 */
export const CALL_OVERHEAD_INPUT_TOKENS = 900;
export const CALL_OUTPUT_TOKENS = 200;
/** The estimate is what the owner confirms, so it rounds towards more: a quarter on top. */
export const ESTIMATE_MARGIN = 1.25;

/**
 * POST /v1/import/estimate (write-path.md §10.5 step 1), from counts only: one extractor call per
 * extract item; input ≈ chars / 4 plus each call's instructions and schema, output ≈ a fixed amount
 * per call (constants above), at the model's price, plus a margin. Items an earlier import of the
 * same file (same SHA-256) already read with the current extractor are skipped by their keys, so
 * they are taken off; items read by an older extractor are read again and cost again. Nothing else
 * can be known from counts. Atomic sources make no call and cost nothing.
 */
export function estimate(
	ctx: StoreContext,
	llm: Llm,
	cap: number,
	r: z.infer<typeof ImportEstimateRequest>,
): z.infer<typeof ImportEstimateResponse> {
	const remaining = Math.max(0, Math.floor((cap - llm.importSpent()) * 100) / 100);
	if (!EXTRACTED.has(r.source_type) || r.item_count === 0) {
		return {
			estimate_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_hits: 0,
			import_budget_remaining_usd: remaining,
		};
	}
	const recorded = (
		prepared(
			ctx.db,
			`SELECT count(*) n FROM import_item i JOIN import_batch b ON b.id = i.batch_id
      WHERE b.file_sha256 = ? AND b.source_type = ? AND i.extractor_version = ? AND i.outcome <> 'queued'`,
		).get(r.file_sha256, r.source_type, EXTRACT_PROMPT_VERSION) as { n: number }
	).n;
	const cacheHits = Math.min(recorded, r.item_count);
	const calls = r.item_count - cacheHits;
	const left = calls / r.item_count;
	const input = Math.ceil(
		(Math.ceil(r.chars / 4) * left + calls * (EXTRACT_PROMPT_TOKENS + CALL_OVERHEAD_INPUT_TOKENS)) * ESTIMATE_MARGIN,
	);
	const output = Math.ceil(calls * CALL_OUTPUT_TOKENS * ESTIMATE_MARGIN);
	const price = priceOf(llm.modelId);
	const usd = (input * price.input_per_mtok + output * price.output_per_mtok) / 1_000_000;
	return {
		estimate_usd: Math.ceil(usd * 100) / 100,
		input_tokens: input,
		output_tokens: output,
		cache_hits: cacheHits,
		import_budget_remaining_usd: remaining,
	};
}

/** The whole dollars the owner types to confirm an estimate: rounded up, so $0.01 is 1. */
export const confirmDollars = (estimateUsd: number): number => Math.ceil(Math.round(estimateUsd * 100) / 100);
