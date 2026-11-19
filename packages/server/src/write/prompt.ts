// Prompt intake and capture (write-path.md §10.1, §10.3).
//
// The prompt hook sends each user prompt (already redacted on the PC) as a `/v1/writes` entry with
// `op: prompt`. The server keeps it for 24 hours, so the coding-tool `user_words` check can find
// the user's words. In repos with capture on, prompts are batched per tool session into an
// `extract` job. With a model, the extractor reads the batch and each fact that passes the span
// check runs the decision table at T2 (§10.2); without one (provider none, no key, or the daily
// cap reached), a sentence with remember intent becomes an observation (§10.3).
//
// A batch waits up to 10 minutes, so when it runs the write pre-checks (§5) are made again: if the
// coding tool's access was revoked or made read-only, or its repo was disabled or had capture
// turned off, meanwhile, the batch's prompts are not read and nothing is saved.

import { createHash } from "node:crypto";
import { redact } from "@memory-anywhere/contracts/redact";
import { norm } from "@memory-anywhere/contracts/normalize";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { transaction, prepared } from "../store/db.ts";
import type { Llm } from "../llm/adapter.ts";
import { CAPTURE_EXTRACT_PROMPT_VERSION, extractCall, messageId } from "../llm/prompts.ts";
import { REMEMBER_INTENT } from "../policy/generated.ts";
import { lexicon } from "../policy/lexicon.ts";
import { ExtractRetry, spanCheck } from "./imports.ts";
import { save, type WriteEnv } from "./pipeline.ts";
import type { Caller } from "./types.ts";

const REMEMBER = lexicon(REMEMBER_INTENT, "substring");
const BATCH_IDLE_MS = 10 * 60 * 1000;
const BATCH_MAX = 20;
const PROMPT_MAX = 8000;
/** No-LLM capture's extractor version, part of capture idempotency keys (write-path.md §2.3). */
export const NO_LLM_EXTRACTOR = "nollm-1";

export interface PromptResult {
	readonly idempotency_key: string;
	readonly outcome: "active" | "rejected";
	readonly reason: "prompt_stored" | "repo_not_enabled";
}

interface ExtractPayload {
	readonly client_id: string;
	readonly repo_key: string;
	readonly tool_session: string;
	readonly prompt_ids: string[];
}

export function intakePrompt(
	env: WriteEnv,
	caller: Caller,
	key: string,
	prompt: string,
	toolSession: string,
	observedAt: number,
): PromptResult {
	const { ctx, config } = env;
	return transaction(ctx.db, () => {
		const stored = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(key) as
			{ result_json: string } | undefined;
		if (stored) return JSON.parse(stored.result_json) as PromptResult;
		const now = ctx.clock.now();
		const repo = prepared(ctx.db, "SELECT enabled, capture FROM repo WHERE repo_key = ?").get(
			caller.repoKey ?? "none",
		) as { enabled: number; capture: number } | undefined;
		const accepted = caller.clientClass === "coding" && repo?.enabled === 1;
		const result: PromptResult = accepted
			? { idempotency_key: key, outcome: "active", reason: "prompt_stored" }
			: { idempotency_key: key, outcome: "rejected", reason: "repo_not_enabled" };
		if (accepted) {
			const id = ctx.ids.newId("spr", now);
			prepared(
				ctx.db,
				"INSERT INTO session_prompt (id, client_id, repo_key, tool_session, prompt, received_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(
				id,
				caller.clientId,
				caller.repoKey ?? "none",
				toolSession,
				redact(prompt).text.slice(0, PROMPT_MAX),
				iso(now),
				iso(now + config.retention.session_prompt_hours * HOUR_MS),
			);
			if (repo?.capture === 1) addToBatch(ctx, caller, toolSession, id, now);
		}
		prepared(
			ctx.db,
			`INSERT INTO write_request (idempotency_key, client_id, op, received_at, observed_at, outcome, reason, result_json, expires_at)
         VALUES (?, ?, 'prompt', ?, ?, ?, ?, ?, ?)`,
		).run(
			key,
			caller.clientId,
			iso(now),
			iso(observedAt),
			result.outcome,
			result.reason,
			JSON.stringify(result),
			iso(now + config.retention.write_request_days * DAY_MS),
		);
		return result;
	});
}

/** Adds a prompt to its session's open extraction batch (flushed after 10 idle minutes or 20 prompts). */
function addToBatch(ctx: StoreContext, caller: Caller, toolSession: string, promptId: string, now: number): void {
	const open = (
		prepared(ctx.db, "SELECT id, payload_json FROM job WHERE kind = 'extract' AND status = 'queued'").all() as {
			id: string;
			payload_json: string;
		}[]
	)
		.map((j) => ({ id: j.id, payload: JSON.parse(j.payload_json) as ExtractPayload }))
		.find(
			(j) =>
				j.payload.client_id === caller.clientId &&
				j.payload.repo_key === caller.repoKey &&
				j.payload.tool_session === toolSession,
		);
	if (open) {
		const ids = [...open.payload.prompt_ids, promptId];
		const nextAt = ids.length >= BATCH_MAX ? now : now + BATCH_IDLE_MS;
		prepared(ctx.db, "UPDATE job SET payload_json = ?, next_at = ? WHERE id = ?").run(
			JSON.stringify({ ...open.payload, prompt_ids: ids }),
			iso(nextAt),
			open.id,
		);
		return;
	}
	const payload: ExtractPayload = {
		client_id: caller.clientId,
		repo_key: caller.repoKey ?? "none",
		tool_session: toolSession,
		prompt_ids: [promptId],
	};
	prepared(
		ctx.db,
		"INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, 'extract', ?, 0, ?, 'queued', ?)",
	).run(ctx.ids.newId("job", now), JSON.stringify(payload), iso(now + BATCH_IDLE_MS), iso(now));
}

/** Sentences of a prompt (split on `.`, `!`, `?` and newlines) that show remember intent. */
export function rememberSentences(prompt: string): string[] {
	return prompt
		.split(/[.!?\n]+/u)
		.map((s) => s.trim())
		.filter((s) => s !== "" && REMEMBER.matches(norm(s)));
}

/**
 * The write pre-checks (write-path.md §5) for a batch about to run: the coding tool is not revoked
 * and may write, and its repo is still enabled with capture on. The prompts were batched under
 * these conditions, but the batch runs up to 10 minutes later.
 */
function mayCapture(ctx: StoreContext, p: ExtractPayload): boolean {
	return (
		prepared(
			ctx.db,
			`SELECT 1 FROM client_policy c, repo r
      WHERE c.client_id = ? AND c.revoked_at IS NULL AND c.write = 1 AND r.repo_key = ? AND r.enabled = 1 AND r.capture = 1`,
		).get(p.client_id, p.repo_key) !== undefined
	);
}

/** The capture caller of one batch: the coding tool's session, at T2 (write-path.md §2.1). */
function captureCaller(p: ExtractPayload): Caller {
	return {
		clientId: p.client_id,
		clientClass: "coding",
		channel: "capture",
		tier: 2,
		sessionKey: `${p.client_id}:${p.tool_session}`,
		repoKey: p.repo_key,
		tool: undefined,
		floored: false,
		canElicit: false,
		elicitationAnswer: undefined,
	};
}

/** Capture's idempotency key (write-path.md §2.3): one per extracted item of one prompt. */
const captureKey = (promptId: string, extractor: string, ordinal: number): string =>
	createHash("sha256")
		.update(["capture", promptId, extractor, String(ordinal)].join("\n"), "utf8")
		.digest("hex");

/**
 * The `extract` job of a capture batch (write-path.md §10.1–10.2). The extractor reads the batch's
 * prompts (live budget); each item must quote, verbatim, the prompt it names, and its content words
 * must come from that prompt. A passing item is saved at T2 with the span as `user_words` and the
 * prompt's remember intent as `explicit_request`, and the decision table decides it. When the model
 * is off, has no key or is at its daily cap, the batch falls back to the no-LLM rule (§10.3). A
 * timeout or error is retried by the worker. A batch that fails the write pre-checks when it runs
 * saves nothing. Returns how many items were saved.
 */
export async function runCaptureExtract(env: WriteEnv, llm: Llm | undefined, payloadJson: string): Promise<number> {
	const payload = JSON.parse(payloadJson) as ExtractPayload;
	if (!mayCapture(env.ctx, payload)) return 0;
	if (!llm?.configured) return noLlmExtract(env, payload);
	const prompts = payload.prompt_ids.flatMap((id) => {
		const row = prepared(env.ctx.db, "SELECT prompt FROM session_prompt WHERE id = ?").get(id) as
			{ prompt: string | null } | undefined;
		return row?.prompt ? [{ id, text: row.prompt }] : [];
	});
	if (prompts.length === 0) return 0;
	const answer = await llm.ask(
		extractCall(
			prompts.map((p) => p.text),
			"capture",
		),
		"live",
	);
	if (!answer.ok) {
		if (answer.why === "cap" || answer.why === "off" || answer.why === "no_key") return noLlmExtract(env, payload);
		throw new ExtractRetry(answer.why);
	}
	const caller = captureCaller(payload);
	const ordinals = new Map<string, number>();
	let saved = 0;
	for (const x of answer.value.items) {
		const prompt = prompts.find((_, i) => messageId(i) === x.prompt_id);
		if (!prompt || spanCheck(x, [prompt.text], env.config.write.capture_support_min)) continue;
		const ordinal = ordinals.get(prompt.id) ?? 0;
		ordinals.set(prompt.id, ordinal + 1);
		const r = await save(
			env,
			caller,
			{
				content: x.content.trim(),
				kind: x.kind,
				why_durable: "extracted from the user's prompt",
				user_words: [...x.span.trim()].slice(0, 200).join(""),
				explicit_request: REMEMBER.matches(norm(prompt.text)),
				section: x.section?.trim() || undefined,
				entity: x.entity?.trim() || "self",
				attribute: x.attribute?.trim() || undefined,
				scope: "global",
				change: "update",
			},
			{
				idempotencyKey: captureKey(prompt.id, CAPTURE_EXTRACT_PROMPT_VERSION, ordinal),
				observedAt: env.ctx.clock.now(),
				extracted: true,
			},
		);
		if (r.kind === "result" && r.outcome.outcome !== "rejected") saved++;
	}
	return saved;
}

/**
 * The `extract` job without an LLM (write-path.md §10.3): every sentence with remember intent
 * becomes an observation candidate (content = the sentence, kind fact), forced to `observation`
 * with reason `capture_no_llm`. Screens still apply: a secret, a sensitive topic or a suppressed
 * text is rejected, never staged. As with the extractor, a batch that fails the write pre-checks
 * saves nothing.
 */
export async function runNoLlmExtract(env: WriteEnv, payloadJson: string): Promise<number> {
	const payload = JSON.parse(payloadJson) as ExtractPayload;
	return mayCapture(env.ctx, payload) ? noLlmExtract(env, payload) : 0;
}

async function noLlmExtract(env: WriteEnv, payload: ExtractPayload): Promise<number> {
	let staged = 0;
	for (const promptId of payload.prompt_ids) {
		const row = prepared(env.ctx.db, "SELECT prompt FROM session_prompt WHERE id = ?").get(promptId) as
			{ prompt: string | null } | undefined;
		if (!row?.prompt) continue;
		const sentences = rememberSentences(row.prompt);
		for (const [ordinal, sentence] of sentences.entries()) {
			if (sentence.includes("[REDACTED:")) continue;
			const content = [...sentence].slice(0, 400).join("");
			const r = await save(
				env,
				captureCaller(payload),
				{
					content,
					kind: "fact",
					why_durable: "extracted from the user's prompt",
					user_words: [...sentence].slice(0, 200).join(""),
					explicit_request: true,
					entity: "self",
					scope: "global",
					change: "update",
				},
				{ idempotencyKey: captureKey(promptId, NO_LLM_EXTRACTOR, ordinal), observedAt: env.ctx.clock.now() },
			);
			if (r.kind === "result" && r.outcome.outcome === "observation") staged++;
		}
	}
	return staged;
}
