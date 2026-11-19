// The write pipeline (write-path.md §1): one entry point for every save, whatever the channel.
//   pre-checks → idempotency → verify → resolve → screens (+ LLM sensitive check) → decision table
//   (+ LLM slot proposal before D14, + LLM durability judge after D14–D18) → embedding (outside the
//   transaction) → one transaction: store rules or observation or review, FTS, events, write_request.
// Saves from tools, spool replays, capture and imports all come through `save()`; forgets through
// `forget()`. Imports make no live LLM call per item (no sensitive check, no slot proposal): their
// items are screened by the lexicons, the extractor already proposed a slot for extracted facts, and
// a call per item would slow every upload and spend outside the estimate the owner confirmed.

import { createHash } from "node:crypto";
import { norm } from "@memory-anywhere/contracts/normalize";
import { reasonMessage, USER_WORDS_NOT_FOUND_SUFFIX, type ReasonCode } from "@memory-anywhere/contracts/reasons";
import type { ServerConfigT } from "../config/schema.ts";
import type { Alerts } from "../ops/alerts.ts";
import type { Embedder } from "../embed/types.ts";
import type { Llm } from "../llm/adapter.ts";
import { durabilityJudge, sensitiveCheck } from "../llm/prompts.ts";
import { noteKeyMissing, proposeSlot, queueReslot } from "../llm/slots.ts";
import type { SensitiveCategory } from "../policy/generated.ts";
import { POLICY_VERSION } from "../policy/generated.ts";
import { DAY_MS, HOUR_MS, iso, sixHourBucket } from "../store/clock.ts";
import { clientPolicy, notePolicyVersion } from "../store/client-policy.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { requireMeta } from "../store/meta.ts";
import { decide, type DecideInput, type ImportClass } from "./decide.ts";
import { assertEvalStore, modelOnlyDecision, type EvalBuild } from "./eval-build.ts";
import { forgetByClient, type ForgetResult } from "./forget.ts";
import { addMention } from "./observations.ts";
import { loadRegistry, resolve } from "./resolve.ts";
import {
	createReview,
	currentVersion,
	insertSource,
	linkSource,
	memoryRow,
	periodStart,
	refreshFts,
	type MemoryRow,
} from "./rows.ts";
import { instructionHit, secretHit, sensitiveCategory, shortLivedHit } from "./screens.ts";
import { applyStoreRules, storeForReview, type StoreProposal, type StoreResult } from "./store-rules.ts";
import { isSuppressed, liftMatching } from "./suppression.ts";
import {
	tierLabel,
	WriteError,
	type Caller,
	type Decision,
	type Resolution,
	type SaveRequest,
	type Screens,
	type TierNum,
	type Verified,
	type WriteOutcome,
} from "./types.ts";
import { verify } from "./verify.ts";

export interface WriteEnv {
	readonly ctx: StoreContext;
	readonly config: ServerConfigT;
	readonly embedder: Embedder;
	/** Called after each commit with the memories whose search entries changed. */
	readonly onCommit?: (touchedMemoryIds: readonly string[]) => void;
	/** Quota and remote-supersede alerts (operations.md §2); none in unit tests. */
	readonly alerts?: Alerts;
	/** The LLM adapter (write-path.md §6.2); absent means provider none. */
	readonly llm?: Llm;
	/** Eval harness only: suite P's "model only" arm, refused on any store but an in-memory one (eval-build.ts). */
	readonly evalBuild?: EvalBuild;
}

/** Rows the slot proposal runs before: only saves no earlier row decided (write-path.md §6.1 step 2.3). */
const SLOT_ROWS: ReadonlySet<string> = new Set(["D14", "D15", "D16", "D17", "D18", "D19"]);

/** Rows whose outcome the durability judge may stage instead of storing (write-path.md §5). */
const JUDGED_ROWS: ReadonlySet<string> = new Set(["D14", "D15", "D16", "D17", "D18"]);

/**
 * The `judge` call (write-path.md §5, §6.2), when `llm.judge` is on: a save rows D14–D18 stored as
 * active at T2 or below asks the model whether it passes the policy's test (memory-policy.md §1).
 * A "not durable" stages it as an observation (`judge_not_durable`), which is promoted if it comes
 * up again like any other; the judge never touches a promotion, nor any other outcome. Timeout,
 * error or cap: the outcome stands.
 */
async function judged(
	env: WriteEnv,
	llm: Llm | undefined,
	d: Decision,
	content: string,
	kind: SaveRequest["kind"],
): Promise<Decision> {
	if (!llm || !env.config.llm.judge || !JUDGED_ROWS.has(d.row) || d.kind !== "active" || d.tier < 2) return d;
	const verdict = await llm.ask(durabilityJudge({ content, kind }));
	return verdict.ok && !verdict.value.durable
		? { row: d.row, kind: "observation", reason: "judge_not_durable", floored: false }
		: d;
}

/**
 * The `sensitive_check` call (memory-policy.md §7.3), for a save rows D1–D2 will not decide and the
 * lexicons did not flag. It can only add a category, and only one the owner blocks.
 */
async function llmSensitive(
	env: WriteEnv,
	content: string,
	userWords: string | undefined,
): Promise<SensitiveCategory | undefined> {
	if (!env.llm || !env.config.sensitive.llm_check) return undefined;
	const a = await env.llm.ask(
		sensitiveCheck(
			userWords
				? `${content}
(the user's words: ${userWords})`
				: content,
		),
	);
	if (!a.ok || a.value.sensitive_category === "none") return undefined;
	return env.config.sensitive.blocked.includes(a.value.sensitive_category) ? a.value.sensitive_category : undefined;
}

export interface RequestMeta {
	readonly idempotencyKey: string;
	/** When the user said it: receipt time for live calls, `spooled_at` for replays, the upload time for imports. */
	readonly observedAt: number;
	/** Channel import only. */
	readonly import?: ImportMeta | undefined;
	/**
	 * Channel capture only: the item came from the extractor, so the decision table decides it like
	 * any save (write-path.md §10.2 step 4). Without it, capture is §10.3's no-LLM rule: every
	 * candidate that passes the screens is staged as an observation.
	 */
	readonly extracted?: boolean | undefined;
}

/** What an import adds to a save (write-path.md §10.4). */
export interface ImportMeta {
	readonly batchId: string;
	readonly class: ImportClass;
	/** The extractor's slot for an extracted fact: a proposal, which may fill or contest a slot but never update it. */
	readonly proposedAttribute?: string | undefined;
	/**
	 * When the owner said it (the conversation's date). It dates the fact (valid_from, an observation's
	 * first sighting) but never moves an observation's expiry, which counts from the import.
	 */
	readonly saidAt?: number | undefined;
}

export type SaveResult =
	| { readonly kind: "result"; readonly outcome: WriteOutcome }
	| { readonly kind: "input_required"; readonly question: string };

/** Idempotency key for MCP saves from clients without their own key (write-path.md §2.3). */
export function mcpIdempotencyKey(clientId: string, req: SaveRequest, contentHash: string, nowMs: number): string {
	const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
	const fields = [
		clientId,
		contentHash,
		req.kind,
		req.user_words === undefined ? "" : sha(norm(req.user_words)),
		String(req.explicit_request),
		req.supersedes ?? "",
		String(sixHourBucket(nowMs)),
	];
	return sha(fields.join("\n"));
}

function storedResult(ctx: StoreContext, key: string): WriteOutcome | undefined {
	const row = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(key) as
		{ result_json: string } | undefined;
	return row ? (JSON.parse(row.result_json) as WriteOutcome) : undefined;
}

type RequestOp = "save" | "forget" | "prompt" | "capture" | "import" | "admin";

function recordRequest(
	env: WriteEnv,
	caller: Caller,
	op: RequestOp,
	m: RequestMeta,
	outcome: { outcome: string; reason: string },
	result: unknown,
): void {
	const now = env.ctx.clock.now();
	prepared(
		env.ctx.db,
		`INSERT INTO write_request (idempotency_key, client_id, op, received_at, observed_at, outcome, reason, result_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		m.idempotencyKey,
		caller.clientId,
		op,
		iso(now),
		iso(m.observedAt),
		outcome.outcome,
		outcome.reason,
		JSON.stringify(result),
		iso(now + env.config.retention.write_request_days * DAY_MS),
	);
}

function sectionName(ctx: StoreContext, id: string): string {
	return (
		(prepared(ctx.db, "SELECT name FROM section WHERE id = ?").get(id) as { name: string } | undefined)?.name ??
		"Unsorted"
	);
}

/** Pre-checks that are errors, not outcomes (write-path.md §5): client, repo, quota. */
function preChecks(env: WriteEnv, caller: Caller, op: "save" | "forget"): void {
	// The owner's channels, the capture job and an import the owner approved are not an app's calls.
	if (
		caller.channel === "admin" ||
		caller.channel === "review_approve" ||
		caller.channel === "capture" ||
		caller.channel === "import"
	)
		return;
	const client = clientPolicy(env.ctx.db, caller.clientId);
	if (!client || client.revoked_at)
		throw new WriteError("FORBIDDEN", "this app was disconnected; connect it again from the app's own settings");
	if (client.write !== 1)
		throw new WriteError(
			"READ_ONLY_CLIENT",
			"the owner made this app read-only; saving can be turned back on in the admin page under Apps",
		);
	if (caller.clientClass === "coding") {
		const repo = prepared(env.ctx.db, "SELECT enabled FROM repo WHERE repo_key = ?").get(caller.repoKey ?? "none") as
			{ enabled: number } | undefined;
		if (!repo || repo.enabled !== 1)
			throw new WriteError("REPO_NOT_ENABLED", "Run `mema enable` in this repository to use memory here.");
	}
	if (op === "save") {
		const since = iso(env.ctx.clock.now() - HOUR_MS);
		const n = (
			prepared(
				env.ctx.db,
				"SELECT count(*) n FROM write_request WHERE client_id = ? AND op = 'save' AND received_at > ?",
			).get(caller.clientId, since) as { n: number }
		).n;
		if (n >= client.quota_saves_per_hour) {
			env.alerts?.raise("save_quota", { quota: client.quota_saves_per_hour }, { subject: caller.clientId });
			throw new WriteError("RATE_LIMITED", "hourly save limit reached", undefined, 3600);
		}
	}
}

/**
 * Waits up to 1.5 s for a session prompt that contains the user's words (write-path.md §4 step 5).
 * Only a coding tool's own saves are checked, and only in an enabled repo, where its prompts are
 * logged; the owner's admin and review channels and the capture job are not tool calls.
 */
function promptFinder(env: WriteEnv, caller: Caller): ((u: string) => Promise<boolean>) | undefined {
	if (caller.clientClass !== "coding" || (caller.channel !== "mcp" && caller.channel !== "spool_save"))
		return undefined;
	const repo = caller.repoKey
		? (prepared(env.ctx.db, "SELECT enabled FROM repo WHERE repo_key = ?").get(caller.repoKey) as
				{ enabled: number } | undefined)
		: undefined;
	if (repo?.enabled !== 1) return undefined;
	return async (needle) => {
		const since = iso(env.ctx.clock.now() - DAY_MS);
		const look = () =>
			(
				prepared(
					env.ctx.db,
					"SELECT prompt FROM session_prompt WHERE client_id = ? AND repo_key = ? AND received_at > ? AND prompt IS NOT NULL",
				).all(caller.clientId, caller.repoKey ?? "none", since) as { prompt: string }[]
			).some((p) => norm(p.prompt).includes(needle));
		for (let waited = 0; ; waited += 250) {
			if (look()) return true;
			if (waited >= 1500) return false;
			await new Promise((r) => setTimeout(r, 250));
		}
	};
}

/** `expires_at` of an active event (write-path.md §5 D13, D10a). */
function eventExpiry(env: WriteEnv, req: SaveRequest, validFrom: string, tier: TierNum, observedAt: number): string {
	const maxMs = observedAt + env.config.write.event_max_ttl_days * DAY_MS;
	if (req.expires_on) {
		const end = Date.parse(`${req.expires_on}T23:59:59.999Z`);
		return iso(tier === 0 ? end : Math.min(end, maxMs));
	}
	return iso(Date.parse(periodStart(validFrom)) + env.config.write.event_default_ttl_days * DAY_MS);
}

function outcomeFor(env: WriteEnv, stored: StoreResult, key: string, reasonOverride?: string): WriteOutcome {
	const reason = (reasonOverride ?? stored.reason) as ReasonCode;
	const contested = stored.status === "contested";
	return {
		outcome: stored.status === "pending_review" ? "review" : "active",
		reason: contested ? "contested" : reason,
		message: reasonMessage(contested ? "contested" : reason),
		id: stored.memoryId,
		tier: tierLabel(stored.tier),
		section: sectionName(env.ctx, stored.sectionId),
		memory_status: stored.status,
		...(stored.contestedWith.length > 0 ? { contested_with: [...stored.contestedWith] } : {}),
		idempotency_key: key,
		policy_version: POLICY_VERSION,
	};
}

/** What the steps before the store concluded about one save. */
interface Judgement {
	readonly v: Verified;
	readonly resolution: Resolution;
	readonly screens: Screens;
	/** The slot the save names, when its entity already exists; suppressions match on it. */
	readonly slot: { readonly entityId: string; readonly attributeId: string } | undefined;
	readonly scope: string;
	readonly d: Decision;
	/** The slot proposal did not answer in time: ask again once the memory is stored. */
	readonly reslotLater: boolean;
}

/** A decision that stores something. */
type StoringDecision = Exclude<Decision, { kind: "reject" } | { kind: "elicit" }>;

export async function save(env: WriteEnv, caller: Caller, req: SaveRequest, m: RequestMeta): Promise<SaveResult> {
	const { ctx } = env;
	if (env.evalBuild?.bypassRules) assertEvalStore(ctx.db, env.config);
	const stored = storedResult(ctx, m.idempotencyKey);
	if (stored) return { kind: "result", outcome: stored };
	preChecks(env, caller, "save");

	const j = await judge(env, caller, req, m);
	const { d } = j;
	if (d.kind === "elicit") return { kind: "input_required", question: d.question };

	const op: RequestOp = caller.channel === "capture" ? "capture" : caller.channel === "import" ? "import" : "save";
	const suffix = j.v.userWordsUnsupported ? USER_WORDS_NOT_FOUND_SUFFIX : "";
	/** Inside the transaction: the reason suffix, the search entries, and the idempotency record. */
	const finish = (o: WriteOutcome, touched: readonly string[]): WriteOutcome => {
		const out = suffix && o.outcome !== "rejected" ? { ...o, reason: o.reason + suffix } : o;
		for (const id of touched) refreshFts(ctx, id);
		recordRequest(env, caller, op, m, out, out);
		return out;
	};

	if (d.kind === "reject") {
		const rejected: WriteOutcome = {
			outcome: "rejected",
			reason: d.reason,
			message: reasonMessage(d.reason),
			idempotency_key: m.idempotencyKey,
			policy_version: POLICY_VERSION,
		};
		return { kind: "result", outcome: transaction(ctx.db, () => finish(rejected, [])) };
	}

	// Embedding takes tens of milliseconds, so it runs before the transaction, not inside it.
	const [vector] = await env.embedder.embedDocuments([j.v.content]);
	if (!vector) throw new WriteError("STORE_UNAVAILABLE", "embedding failed");
	let touched: readonly string[] = [];
	const out = transaction(ctx.db, () => {
		const r = storeDecision(env, caller, req, m, { ...j, d }, vector);
		touched = r.touched;
		return finish(r.outcome, r.touched);
	});
	if (req.policy_version !== undefined)
		notePolicyVersion(ctx.db, caller.clientId, req.policy_version, iso(ctx.clock.now()));
	env.onCommit?.(touched);
	return { kind: "result", outcome: out };
}

/** Verify, resolve, screen and decide (write-path.md §4–§7), with the model's help where it is on. */
async function judge(env: WriteEnv, caller: Caller, req: SaveRequest, m: RequestMeta): Promise<Judgement> {
	const { ctx, config } = env;
	const v = await verify(req, { supportMin: config.write.support_min, findInPrompts: promptFinder(env, caller) });
	const registry = loadRegistry(ctx.db);
	const resolveInput = {
		content: v.content,
		entity: req.entity,
		attribute: req.attribute,
		section: req.section,
		proposed: m.import?.proposedAttribute,
	};
	let resolution = resolve(ctx.db, registry, resolveInput);
	const slot =
		!resolution.entity.isNew && resolution.attribute
			? { entityId: resolution.entity.id, attributeId: resolution.attribute.id }
			: undefined;
	const noLlmCapture = caller.channel === "capture" && m.extracted !== true;
	// Imports call no model per item; no-LLM capture runs when the model is off or at its cap; the
	// eval build's model-only arm has no server stage at all.
	const bypass = env.evalBuild?.bypassRules === true;
	const llm = bypass || noLlmCapture || caller.channel === "import" || !env.llm?.configured ? undefined : env.llm;
	const screens = await screen(env, caller, req, v, slot, llm);
	const { scope, visible } = scopesOf(req, caller);

	let input: DecideInput = {
		tier: caller.tier,
		channel:
			caller.channel === "spool_save" ||
			caller.channel === "capture" ||
			caller.channel === "admin" ||
			caller.channel === "import"
				? caller.channel
				: "mcp",
		importClass: m.import?.class,
		kind: req.kind,
		explicitRequest: req.explicit_request,
		supersedes: req.supersedes,
		verified: v,
		screens,
		resolution,
		duplicateOf: duplicateOf(ctx, v.contentHash, visible),
		floored: caller.floored,
		canElicit: caller.canElicit,
		elicitationAnswer: caller.elicitationAnswer,
	};
	let d = bypass ? modelOnlyDecision(caller.tier) : decide(input);
	// Step 2.3: a free-text save no earlier row decided asks the LLM for its slot, then the table
	// runs again on the new resolution (rows before D14 do not depend on the attribute).
	let reslotLater = false;
	if (llm && SLOT_ROWS.has(d.row) && !resolution.attribute) {
		const entityType = resolution.entity.isNew ? undefined : resolution.entity.type;
		const proposal = await proposeSlot(llm, registry, { content: v.content, entity: req.entity, entityType });
		if (proposal.ok && proposal.value) {
			resolution = resolve(ctx.db, registry, { ...resolveInput, proposed: proposal.value });
			input = { ...input, resolution };
			d = decide(input);
		} else if (!proposal.ok && proposal.why === "no_key") noteKeyMissing(ctx);
		else if (!proposal.ok && proposal.why !== "off") reslotLater = true;
	}
	d = await judged(env, llm, d, v.content, req.kind);
	// No-LLM capture stages every candidate that passes the screens (write-path.md §10.3).
	if (noLlmCapture && (d.kind === "active" || d.kind === "observation")) {
		d = { row: d.row, kind: "observation", reason: "capture_no_llm", floored: false };
	}
	return { v, resolution, screens, slot, scope, d, reslotLater };
}

/** The deterministic screens (write-path.md §7), and the model's sensitive check when the lexicons found nothing. */
async function screen(
	env: WriteEnv,
	caller: Caller,
	req: SaveRequest,
	v: Verified,
	slot: Judgement["slot"],
	llm: Llm | undefined,
): Promise<Screens> {
	const { ctx, config } = env;
	const screens: Screens = {
		secretHit: secretHit([v.content, v.userWords, v.whyDurable]),
		instructionHit: instructionHit(v.content, req.kind),
		sensitiveCategory: sensitiveCategory([v.content, v.userWords], config.sensitive.blocked),
		shortLivedHit: shortLivedHit(v.content),
		suppressionHit: isSuppressed(ctx, v.content, slot),
	};
	if (!llm || screens.secretHit || (caller.tier !== 0 && screens.instructionHit) || screens.sensitiveCategory)
		return screens;
	const category = await llmSensitive({ ...env, llm }, v.content, v.userWords);
	return category ? { ...screens, sensitiveCategory: category } : screens;
}

/** The scope a save is stored in, and the scopes its caller can see (where a duplicate would count). */
function scopesOf(req: SaveRequest, caller: Caller): { scope: string; visible: string[] } {
	const repo =
		caller.clientClass === "coding" && caller.repoKey && caller.repoKey !== "none" ? caller.repoKey : undefined;
	const scope = req.scope === "repo" && repo ? `repo:${repo}` : "global";
	const visible =
		scope === "global"
			? ["global", ...(caller.repoKey && caller.repoKey !== "none" ? [`repo:${caller.repoKey}`] : [])]
			: ["global", scope];
	return { scope, visible };
}

/** The oldest live memory with exactly this content in one of `scopes`. */
function duplicateOf(ctx: StoreContext, contentHash: string, scopes: string[]): string | undefined {
	const row = prepared(
		ctx.db,
		`SELECT m.id FROM memory m JOIN memory_version cv ON cv.memory_id = m.id
       WHERE cv.content_norm_hash = ? AND cv.valid_to IS NULL AND cv.expired_at IS NULL AND m.status IN ('active','contested') AND m.scope IN (${scopes.map(() => "?").join(", ")})
       ORDER BY m.created_at, m.id LIMIT 1`,
	).get(contentHash, ...scopes) as { id: string } | undefined;
	return row?.id;
}

/** Inside the save's transaction: carry out the decision. */
function storeDecision(
	env: WriteEnv,
	caller: Caller,
	req: SaveRequest,
	m: RequestMeta,
	j: Judgement & { readonly d: StoringDecision },
	vector: Float32Array,
): { outcome: WriteOutcome; touched: readonly string[] } {
	const { ctx, config } = env;
	const { v, resolution, screens, scope, d } = j;
	const source = { excerpt: undefined, userWords: v.userWords, observedAt: m.observedAt };
	const modelId = env.embedder.modelId;
	const dupThreshold = Number(requireMeta(ctx.db, "dup_threshold"));
	const key = m.idempotencyKey;

	if (d.kind === "already_stored") {
		const cur = currentVersion(ctx, d.memoryId);
		linkSource(ctx, d.memoryId, cur?.id ?? null, insertSource(ctx, caller), source);
		const memory = memoryRow(ctx, d.memoryId) as MemoryRow & { status: "active" | "contested" };
		const touched = [d.memoryId];
		const stored: StoreResult = {
			memoryId: d.memoryId,
			status: memory.status,
			reason: "already_stored",
			tier: cur?.trust_tier ?? caller.tier,
			sectionId: memory.section_id,
			contestedWith: [],
			touched,
		};
		return { outcome: outcomeFor(env, stored, key), touched };
	}

	if (d.kind === "observation") {
		const mention = addMention(
			ctx,
			caller,
			{
				resolution,
				content: v.content,
				contentHash: v.contentHash,
				kind: req.kind === "instruction" ? "fact" : req.kind,
				scope,
				tier: caller.tier,
				floored: d.floored,
				observedAt: m.observedAt,
				saidAt: m.import?.saidAt,
				vector,
				modelId,
				dupThreshold,
				writeRequestKey: key,
				source,
			},
			config,
		);
		if (mention.promoted)
			return { outcome: outcomeFor(env, mention.stored, key, "recurred"), touched: mention.stored.touched };
		const observed: WriteOutcome = {
			outcome: "observation",
			reason: d.reason,
			message: reasonMessage(d.reason),
			id: mention.observationId,
			tier: tierLabel(caller.tier),
			section: sectionName(ctx, resolution.sectionId),
			idempotency_key: key,
			policy_version: POLICY_VERSION,
		};
		return { outcome: observed, touched: [] };
	}

	const proposal: StoreProposal = {
		resolution,
		content: v.content,
		contentHash: v.contentHash,
		kind: req.kind,
		scope,
		tier: caller.tier,
		reason: d.reason,
		supersedes: req.supersedes,
		change: req.change,
		validFrom: req.valid_from,
		observedAt: m.observedAt,
		expiresAt: undefined,
		sensitivityCategory: undefined,
		vector,
		modelId,
		dupThreshold,
		writeRequestKey: key,
		source,
		nearDupThreshold: caller.channel === "import" ? config.write.import_dup_threshold : dupThreshold,
		extensionMinCosine: config.write.extension_min_cosine,
		rewordedMinCosine: config.write.reworded_min_cosine,
	};

	if (d.kind === "review") {
		const r = storeForReview(
			ctx,
			caller,
			{ ...proposal, sensitivityCategory: screens.sensitiveCategory },
			d.reviewKind,
			m.import ? { batch_id: m.import.batchId } : undefined,
		);
		return { outcome: outcomeFor(env, r, key, d.reason), touched: r.touched };
	}

	// active
	const { tier } = d;
	const expiresAt =
		req.kind === "event"
			? eventExpiry(env, req, req.valid_from ?? iso(m.observedAt).slice(0, 10), tier, m.observedAt)
			: undefined;
	const sensitive = d.row === "D4" || d.row === "D5" ? screens.sensitiveCategory : undefined;
	const r = applyStoreRules(ctx, { ...caller, tier }, { ...proposal, tier, expiresAt, sensitivityCategory: sensitive });
	// A confirmed re-save or an owner save lifts the suppression it matched.
	if (screens.suppressionHit && (tier === 0 || d.row === "D7")) liftMatching(ctx, v.content, j.slot);
	if (d.preferenceConfirm && r.status !== "pending_review" && r.reason !== "already_stored") {
		createReview(ctx, caller, {
			kind: "preference_confirm",
			memoryId: r.memoryId,
			observationId: undefined,
			payload: undefined,
		});
	}
	// A non-owner save that replaced or contested a value is worth a line in the digest.
	if (tier !== 0 && (r.reason === "update" || r.reason === "correction" || r.reason === "contested")) {
		env.alerts?.raise("supersede_remote", { memory: r.memoryId }, { subject: caller.clientId });
	}
	// The slot proposal could not answer in time: ask again later (write-path.md §6.2).
	if (j.reslotLater && (r.status === "active" || r.status === "contested") && r.reason !== "already_stored")
		queueReslot(ctx, r.memoryId);
	return { outcome: outcomeFor(env, r, key), touched: r.touched };
}

export interface ForgetOutcome {
	readonly id: string;
	readonly outcome: "forgotten" | "review" | "already_forgotten";
	readonly message: string;
	readonly undo_until?: string;
}

const FORGET_MESSAGES = {
	forgotten: "forgotten; the owner can undo this for 30 days",
	review: "this memory is protected; the owner will confirm forgetting it",
	already_forgotten: "already forgotten",
} as const;

export async function forget(
	env: WriteEnv,
	caller: Caller,
	id: string,
	m: RequestMeta,
): Promise<{ kind: "result"; outcome: ForgetOutcome } | { kind: "input_required"; question: string }> {
	const { ctx, config } = env;
	const stored = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(
		m.idempotencyKey,
	) as { result_json: string } | undefined;
	if (stored) return { kind: "result", outcome: JSON.parse(stored.result_json) as ForgetOutcome };
	preChecks(env, caller, "forget");
	const since = iso(ctx.clock.now() - DAY_MS);
	const forgetsToday = (
		prepared(
			ctx.db,
			"SELECT count(*) n FROM write_request WHERE client_id = ? AND op = 'forget' AND outcome IN ('forgotten','review') AND received_at > ?",
		).get(caller.clientId, since) as { n: number }
	).n;
	const quota = clientPolicy(ctx.db, caller.clientId)?.quota_forgets_per_day ?? 5;
	if (forgetsToday >= quota) env.alerts?.raise("forget_quota", { quota }, { subject: caller.clientId });
	const r: ForgetResult = forgetByClient(ctx, caller, id, {
		purgeAfterDays: config.retention.forgotten_purge_days,
		quotaPerDay: quota,
		forgetsToday,
	});
	if (r.kind === "elicit") return { kind: "input_required", question: r.question };
	const out: ForgetOutcome = {
		id,
		outcome: r.outcome,
		message: FORGET_MESSAGES[r.outcome],
		...(r.undoUntil ? { undo_until: r.undoUntil } : {}),
	};
	transaction(ctx.db, () => recordRequest(env, caller, "forget", m, { outcome: r.outcome, reason: r.outcome }, out));
	env.onCommit?.(r.touched);
	return { kind: "result", outcome: out };
}
