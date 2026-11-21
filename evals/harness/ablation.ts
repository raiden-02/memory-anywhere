// Suite P's ablation (evals.md §3.3): the model stage's conversations, run through the
// same client model against four server stages, so the report shows what each server stage adds,
// including when it adds nothing.
//
//   arm a  model only          the eval build's rule bypass: every save stored as proposed
//   arm b  model + rules       the decision table, with the server model's slot proposal and sensitive check
//   arm c  model + rules + judge  as b, plus the durability judge on rows D14–D18
//   arm d  no-LLM mode         the decision table alone (provider none)
//
// The client is Claude through Claude Code headless (the local Claude Code sign-in, no key); the server
// model is a local Ollama model (no API keys). Each arm runs every conversation `repeat` times,
// each in a fresh in-memory store, so no answer is cached across runs.
// The server model's calls are counted per call and outcome, with their latency: a call that
// times out falls back to the deterministic rule, so arms b and c can only differ from d where
// the model answered in time.

import { defaultConfig, type ServerConfigT } from "../../packages/server/src/config/schema.ts";
import {
	DEFAULT_OLLAMA_ENDPOINT,
	OLLAMA_PREFIX,
	ollamaProvider,
	type LlmProvider,
	type ProviderReply,
} from "../../packages/server/src/llm/adapter.ts";
import { durabilityJudge, type LlmCall } from "../../packages/server/src/llm/prompts.ts";
import type { EvalServer } from "./headless.ts";
import {
	loadConversations,
	runConversation,
	scoreTurns,
	type SuitePModelResult,
	type TurnResult,
} from "./suite-p-model.ts";

export const ARMS = {
	a: { label: "model only", rules: false, server_model: false, judge: false },
	b: { label: "model + rules", rules: true, server_model: true, judge: false },
	c: { label: "model + rules + judge", rules: true, server_model: true, judge: true },
	d: { label: "no-LLM mode", rules: true, server_model: false, judge: false },
} as const;
export type Arm = keyof typeof ARMS;

export const isArm = (x: string): x is Arm => Object.hasOwn(ARMS, x);

/** The local model of arms b and c unless `--server-model` names another. */
export const DEFAULT_SERVER_MODEL = "gpt-oss:20b";

/** The server model's local address and name. */
export interface ServerModel {
	readonly endpoint: string;
	readonly model: string;
}

/** One server-model call as the provider saw it. */
export interface CallRecord {
	readonly name: string;
	readonly outcome: "ok" | "timeout" | "error";
	readonly ms: number;
}

/** The provider, with every call it answers or fails recorded. */
function recorded(provider: LlmProvider, log: CallRecord[]): LlmProvider {
	return {
		modelId: provider.modelId,
		async ask<T>(call: LlmCall<T>, signal: AbortSignal): Promise<ProviderReply<T>> {
			const start = performance.now();
			try {
				const reply = await provider.ask(call, signal);
				log.push({ name: call.name, outcome: "ok", ms: performance.now() - start });
				return reply;
			} catch (e) {
				const name = e instanceof Error ? e.name : "";
				log.push({
					name: call.name,
					outcome: /timeout|abort/iu.test(name) ? "timeout" : "error",
					ms: performance.now() - start,
				});
				throw e;
			}
		},
	};
}

/** The server stage of one arm. */
export function armServer(arm: Arm, serverModel: ServerModel, log: CallRecord[] = []): EvalServer {
	const base = defaultConfig();
	const spec = ARMS[arm];
	if (!spec.rules) return { config: base, evalBuild: { bypassRules: true } };
	if (!spec.server_model) return { config: base };
	const config: ServerConfigT = {
		...base,
		llm: {
			...base.llm,
			provider: "ollama",
			model: serverModel.model,
			endpoint: serverModel.endpoint,
			judge: spec.judge,
		},
	};
	return { config, llmProvider: recorded(ollamaProvider(serverModel), log) };
}

/**
 * Loads the server model before the first conversation: a cold load takes far longer than any
 * call's 2–3 s limit, and would make the first saves fall back for a reason that is not the model's.
 */
export async function warmServerModel(serverModel: ServerModel): Promise<void> {
	await ollamaProvider(serverModel).ask(
		durabilityJudge({ content: "Prefers short answers", kind: "preference" }),
		AbortSignal.timeout(180_000),
	);
}

/** Nearest-rank percentiles, in whole milliseconds. */
function latency(ms: readonly number[]): { p50: number; p95: number } {
	const sorted = [...ms].sort((x, y) => x - y);
	const at = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0);
	return { p50: at(0.5), p95: at(0.95) };
}

export interface AblationResult extends Pick<
	SuitePModelResult,
	"rates" | "outcomes" | "labels" | "client" | "model" | "n_conversations"
> {
	readonly suite: "P";
	readonly stage: "model";
	/** The arm, and the server model it called (null in arms a and d). */
	readonly ablation: {
		readonly arm: Arm;
		readonly label: string;
		readonly rules: boolean;
		readonly judge: boolean;
		readonly server_model: string | null;
	};
	/** Runs of every conversation; rates pool every turn of every run (n = turns × runs). */
	readonly runs: number;
	readonly per_run: { readonly run: number; readonly rates: SuitePModelResult["rates"] }[];
	/** What the server did with the saves the model made: outcome → reason → count. */
	readonly server_decisions: Record<string, Record<string, number>>;
	/** Server-model calls per call name: answered, timed out (fallback), failed (fallback), and latency. */
	readonly server_model_calls: Record<
		string,
		{ ok: number; timeout: number; error: number; p50_ms: number; p95_ms: number }
	>;
	readonly errors: number;
	readonly turns: (TurnResult & { readonly run: number })[];
}

export async function runAblation(o: {
	arm: Arm;
	model: string;
	serverModel?: ServerModel;
	repeat?: number;
	timeoutMs?: number;
	log?: (line: string) => void;
}): Promise<AblationResult> {
	const repeat = o.repeat ?? 3;
	if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`repeat must be a whole number from 1, not ${repeat}`);
	const spec = ARMS[o.arm];
	const serverModel = o.serverModel ?? { endpoint: DEFAULT_OLLAMA_ENDPOINT, model: DEFAULT_SERVER_MODEL };
	if (spec.server_model) await warmServerModel(serverModel);
	const conversations = loadConversations();
	const calls: CallRecord[] = [];
	const turns: (TurnResult & { run: number })[] = [];
	const decisions: AblationResult["server_decisions"] = {};
	let errors = 0;
	for (let run = 1; run <= repeat; run++) {
		for (const c of conversations) {
			const r = await runConversation(c, {
				model: o.model,
				timeoutMs: o.timeoutMs ?? 300_000,
				server: armServer(o.arm, serverModel, calls),
			});
			if (r.error) errors++;
			for (const s of r.saves) {
				const row = (decisions[s.outcome] ??= {});
				row[s.reason] = (row[s.reason] ?? 0) + 1;
			}
			o.log?.(
				`run ${run} ${c.id}: ${r.turns.map((t) => `${t.label}→${t.outcome}`).join(", ")}${r.error ? ` (${r.error})` : ""}`,
			);
			turns.push(...r.turns.map((t) => ({ ...t, run })));
		}
	}
	const byName: AblationResult["server_model_calls"] = {};
	for (const name of [...new Set(calls.map((c) => c.name))].sort()) {
		const mine = calls.filter((c) => c.name === name);
		const { p50, p95 } = latency(mine.map((c) => c.ms));
		const count = (x: CallRecord["outcome"]) => mine.filter((c) => c.outcome === x).length;
		byName[name] = { ok: count("ok"), timeout: count("timeout"), error: count("error"), p50_ms: p50, p95_ms: p95 };
	}
	const perRun = Array.from({ length: repeat }, (_, i) => ({
		run: i + 1,
		rates: scoreTurns(turns.filter((t) => t.run === i + 1)).rates,
	}));
	return {
		suite: "P",
		stage: "model",
		ablation: {
			arm: o.arm,
			label: spec.label,
			rules: spec.rules,
			judge: spec.judge,
			server_model: spec.server_model ? `${OLLAMA_PREFIX}${serverModel.model}` : null,
		},
		client: "claude-code-headless",
		model: o.model,
		labels: "author",
		n_conversations: conversations.length,
		runs: repeat,
		...scoreTurns(turns),
		per_run: perRun,
		server_decisions: decisions,
		server_model_calls: byName,
		errors,
		turns,
	};
}
