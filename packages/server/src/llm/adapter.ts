// The LLM adapter (write-path.md §6.2): every model call the server makes goes through `Llm.ask`.
// The PC never calls an LLM. One call, in order:
//
//   provider = none ─────────────────────────────► off      (the configured no-LLM mode)
//   anthropic without a key / not built in ──────► no_key   (memory_status: llm_unavailable)
//   extraction_cache hit (30 days) ──────────────► the cached answer, free and repeatable
//   the same call already waiting on the model ──► its answer when it arrives, free (as cached)
//   purpose live:   today's live spend ≥ daily_usd_cap ─► cap   (alert llm_cap, until 00:00 UTC)
//   purpose import: all import spend ≥ import_usd_cap ──► cap   (alert llm_cap; the batch stops, §10.5)
//   a call budget (one import batch's) spent ──────────► budget (the batch stops, §10.5)
//                   (spend counts each call still waiting on the model at its worst case, so calls
//                    that run side by side, operations.md §4, never pass a cap or a budget together)
//   the model, within the call's time limit ─────► the answer, checked against its schema
//                                    └─ too slow ► timeout · anything else ► error
//
// Every failure means "behave as provider = none": callers fall back to their deterministic rule.
// Spend is estimated from the reported token counts and `prices.json`, and recorded per UTC day and
// purpose: live calls (slot proposal, sensitive check, judge) and imports have separate caps.
//
// Providers: `anthropic` (the API, with a key) and `ollama` (a model on the owner's machine, no key).
// A local model's calls go through the same cache, holds, caps and spend rows at $0 a token, so its
// tokens are still counted and a cap of 0 still turns it off.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfigT } from "../config/schema.ts";
import type { Alerts } from "../ops/alerts.ts";
import { DAY_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared } from "../store/db.ts";
import type { LlmCall } from "./prompts.ts";
import PRICES from "./prices.json" with { type: "json" };

/** The model id used when `[llm] model` is empty. */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** What a provider returns for one call. */
export interface ProviderReply<T> {
	readonly value: T;
	readonly tokensIn: number;
	readonly tokensOut: number;
}

/** A model behind the adapter: the Anthropic API or a local Ollama model, a scripted fake in tests. */
export interface LlmProvider {
	readonly modelId: string;
	/** Answers one call or throws. Must stop when `signal` aborts. */
	ask<T>(call: LlmCall<T>, signal: AbortSignal): Promise<ProviderReply<T>>;
}

export type LlmFailure = "off" | "no_key" | "cap" | "budget" | "timeout" | "error";

/** An answer, with what it cost (0 for a cached one). */
export type LlmAnswer<T> =
	{ readonly ok: true; readonly value: T; readonly usd: number } | { readonly ok: false; readonly why: LlmFailure };

/** Which budget a call is spent from (llm_spend.purpose). */
export type SpendPurpose = "live" | "import";

/**
 * A budget of its own that a call also counts against, on top of its purpose's cap: one import
 * batch's (write-path.md §10.5 step 5). `spent` is read when the call is about to go to the model;
 * `record` gets the call's cost as soon as it is known, before its hold is released elsewhere.
 */
export interface CallBudget {
	/** Calls with the same key share the budget (the batch id). */
	readonly key: string;
	readonly usd: number;
	spent(): number;
	record(usd: number): void;
}

interface Price {
	readonly input_per_mtok: number;
	readonly output_per_mtok: number;
}

/** Model ids of provider ollama: the local model's name behind this prefix, so cache keys never mix providers. */
export const OLLAMA_PREFIX = "ollama/";

/** Ollama's own address when `[llm] endpoint` is empty. */
export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

/** A local model runs on the owner's own machine: its calls are counted, at $0. */
const FREE: Price = { input_per_mtok: 0, output_per_mtok: 0 };

export function priceOf(modelId: string): Price {
	if (modelId.startsWith(OLLAMA_PREFIX)) return FREE;
	const price = (PRICES as unknown as Record<string, Price | undefined>)[modelId];
	if (!price) throw new Error(`no price for LLM model ${modelId} in llm/prices.json: add it with the model pin`);
	return price;
}

/** The Anthropic API through the official SDK (ADR-0007), imported only when a key is configured. */
export async function anthropicProvider(apiKey: string, modelId: string): Promise<LlmProvider> {
	priceOf(modelId);
	const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
		import("@anthropic-ai/sdk"),
		import("@anthropic-ai/sdk/helpers/zod"),
	]);
	// Retries would overrun the calls' time limits; a failed sync call falls back instead (§6.2).
	const client = new Anthropic({ apiKey, maxRetries: 0 });
	return {
		modelId,
		async ask<T>(call: LlmCall<T>, signal: AbortSignal): Promise<ProviderReply<T>> {
			const r = await client.messages.parse(
				{
					model: modelId,
					max_tokens: call.maxOutputTokens,
					system: call.system,
					messages: [{ role: "user", content: call.user }],
					thinking: { type: "disabled" },
					output_config: { format: zodOutputFormat(call.schema) },
				},
				{ signal, timeout: call.timeoutMs },
			);
			if (r.stop_reason === "refusal" || r.parsed_output === null || r.parsed_output === undefined) {
				throw Object.assign(new Error(`${call.name}: no structured answer`), {
					name: "LlmNoAnswer",
					code: r.stop_reason ?? "none",
				});
			}
			return { value: r.parsed_output as T, tokensIn: r.usage.input_tokens, tokensOut: r.usage.output_tokens };
		},
	};
}

/** The parts of Ollama's `/api/chat` reply the adapter reads. */
const OllamaChatReply = z.object({
	message: z.object({ content: z.string() }),
	done_reason: z.string().optional(),
	prompt_eval_count: z.int().min(0).default(0),
	eval_count: z.int().min(0).default(0),
});

/** What `/api/show` says about a model: whether it thinks before it answers, and its family. */
const OllamaShowReply = z.object({
	capabilities: z.array(z.string()).default([]),
	details: z.object({ family: z.string().default("") }).default({ family: "" }),
});

/**
 * A model served by Ollama on the owner's machine (no key). The answer is constrained by the call's
 * JSON schema (Ollama's structured outputs) and checked against the same zod schema as the
 * Anthropic path. Thinking is kept at the least the model allows, because every call has a 2–3 s
 * limit: off for models that can turn it off, `low` for gpt-oss, which cannot. The model's
 * capabilities are read on first use, and again after a failure, so a server that starts before
 * Ollama does picks it up later. How long Ollama keeps the model loaded is Ollama's own setting
 * (`OLLAMA_KEEP_ALIVE`); a call that waits for a cold load times out and falls back like any other.
 */
export function ollamaProvider(o: { endpoint: string; model: string; fetch?: typeof fetch }): LlmProvider {
	const base = o.endpoint.replace(/\/+$/u, "");
	const http = o.fetch ?? fetch;
	/** The `think` field to send: absent for a model that never thinks. */
	type Think = boolean | "low" | undefined;
	const readThink = async (signal: AbortSignal): Promise<Think> => {
		const r = await http(`${base}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: o.model }),
			signal,
		});
		if (!r.ok) throw Object.assign(new Error(`ollama /api/show: HTTP ${r.status}`), { name: "LlmHttpError" });
		const show = OllamaShowReply.parse(await r.json());
		if (!show.capabilities.includes("thinking")) return undefined;
		return show.details.family === "gpt-oss" ? "low" : false;
	};
	let think: Promise<Think> | undefined;
	// Read once and shared; a failure is not remembered, so the next call asks again.
	const thinking = (signal: AbortSignal): Promise<Think> =>
		(think ??= readThink(signal).catch((e: unknown) => {
			think = undefined;
			throw e;
		}));
	return {
		modelId: `${OLLAMA_PREFIX}${o.model}`,
		async ask<T>(call: LlmCall<T>, signal: AbortSignal): Promise<ProviderReply<T>> {
			const level = await thinking(signal);
			const r = await http(`${base}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: o.model,
					stream: false,
					messages: [
						{ role: "system", content: call.system },
						{ role: "user", content: call.user },
					],
					format: z.toJSONSchema(call.schema),
					...(level === undefined ? {} : { think: level }),
					// A thinking model spends tokens before it answers, so only the call's time limit bounds it.
					options: { temperature: 0, ...(level ? {} : { num_predict: call.maxOutputTokens }) },
				}),
				signal,
			});
			if (!r.ok) throw Object.assign(new Error(`${call.name}: ollama HTTP ${r.status}`), { name: "LlmHttpError" });
			const reply = OllamaChatReply.parse(await r.json());
			let json: unknown;
			try {
				json = JSON.parse(reply.message.content);
			} catch {
				throw Object.assign(new Error(`${call.name}: no structured answer`), {
					name: "LlmNoAnswer",
					code: reply.done_reason ?? "none",
				});
			}
			const parsed = call.schema.safeParse(json);
			if (!parsed.success)
				throw Object.assign(new Error(`${call.name}: answer outside the schema`), {
					name: "LlmNoAnswer",
					code: "schema",
				});
			return { value: parsed.data, tokensIn: reply.prompt_eval_count, tokensOut: reply.eval_count };
		},
	};
}

/**
 * The provider `[llm]` names. Anthropic takes its key from `MA_LLM_API_KEY` (local mode: the
 * environment; aws mode: /run/memory-anywhere/secrets.env through the unit's EnvironmentFile) and is
 * undefined without one; Ollama needs no key. Undefined too for a provider this version does not
 * build in, so the adapter reports `llm_unavailable`.
 */
export async function providerFromEnv(config: ServerConfigT, env: NodeJS.ProcessEnv): Promise<LlmProvider | undefined> {
	if (config.llm.provider === "ollama")
		return ollamaProvider({ endpoint: config.llm.endpoint || DEFAULT_OLLAMA_ENDPOINT, model: config.llm.model });
	const key = env.MA_LLM_API_KEY?.trim();
	if (config.llm.provider !== "anthropic" || !key) return undefined;
	return anthropicProvider(key, config.llm.model || DEFAULT_MODEL);
}

/** The model id calls would go to under `[llm]`, before any provider exists (estimates, memory_status). */
export function configuredModelId(config: ServerConfigT): string {
	return config.llm.provider === "ollama" ? `${OLLAMA_PREFIX}${config.llm.model}` : config.llm.model || DEFAULT_MODEL;
}

export class Llm {
	readonly #ctx: StoreContext;
	readonly #config: ServerConfigT;
	readonly #provider: LlmProvider | undefined;
	readonly #alerts: Alerts | undefined;
	/** Calls waiting on the model, by cache key, so an identical call shares the answer. */
	readonly #waiting = new Map<string, Promise<LlmAnswer<unknown>>>();
	/** The worst-case cost of the calls waiting on the model, per budget. */
	readonly #held: Record<SpendPurpose, number> = { live: 0, import: 0 };
	/** The same, per call budget (import batch), by its key. */
	readonly #heldFor = new Map<string, number>();

	constructor(o: { ctx: StoreContext; config: ServerConfigT; provider: LlmProvider | undefined; alerts?: Alerts }) {
		this.#ctx = o.ctx;
		this.#config = o.config;
		this.#provider = o.provider;
		this.#alerts = o.alerts;
		if (o.provider) priceOf(o.provider.modelId);
	}

	/** The owner configured an LLM (`provider` is not `none`), whether or not it can be called now. */
	get configured(): boolean {
		return this.#config.llm.provider !== "none";
	}

	/** A model can be called: configured, and a provider exists (anthropic: a key is set). */
	get available(): boolean {
		return this.configured && this.#provider !== undefined;
	}

	/** The model calls go to: the provider's, else the configured pin (for estimates without a key). */
	get modelId(): string {
		return this.#provider?.modelId ?? configuredModelId(this.#config);
	}

	/** What every import so far has spent, across all batches and days (write-path.md §10.5 step 5). */
	importSpent(): number {
		return (
			prepared(this.#ctx.db, "SELECT coalesce(sum(usd), 0) usd FROM llm_spend WHERE purpose = 'import'").get() as {
				usd: number;
			}
		).usd;
	}

	/** memory_status's reason when a configured LLM cannot be used (mcp-interface.md §3.5). */
	degraded(): "llm_unavailable" | "llm_cap" | undefined {
		if (!this.configured) return undefined;
		if (!this.#provider) return "llm_unavailable";
		return this.#spentToday() >= this.#config.llm.daily_usd_cap ? "llm_cap" : undefined;
	}

	/**
	 * One call (see the top of this file). With `budget`, the call also counts against that budget:
	 * a cached or shared answer is free, so only a call that goes to the model is checked and charged.
	 */
	async ask<T>(call: LlmCall<T>, purpose: SpendPurpose = "live", budget?: CallBudget): Promise<LlmAnswer<T>> {
		if (!this.configured) return { ok: false, why: "off" };
		const provider = this.#provider;
		if (!provider) return { ok: false, why: "no_key" };

		const key = createHash("sha256")
			.update(`${call.user}\u0000${call.promptVersion}\u0000${provider.modelId}`, "utf8")
			.digest("hex");
		const now = this.#ctx.clock.now();
		const cached = prepared(
			this.#ctx.db,
			"SELECT output_json FROM extraction_cache WHERE input_hash = ? AND expires_at > ? AND output_json IS NOT NULL",
		).get(key, iso(now)) as { output_json: string } | undefined;
		if (cached) {
			const parsed = call.schema.safeParse(JSON.parse(cached.output_json));
			if (parsed.success) return { ok: true, value: parsed.data, usd: 0 };
		}

		const same = this.#waiting.get(key) as Promise<LlmAnswer<T>> | undefined;
		if (same) {
			const a = await same;
			return a.ok ? { ...a, usd: 0 } : a;
		}
		const answer = this.#call(provider, call, purpose, key, budget);
		this.#waiting.set(key, answer);
		try {
			return await answer;
		} finally {
			this.#waiting.delete(key);
		}
	}

	/** The model call itself, after the cache: the cap, the provider, spend, the schema, the cache row. */
	async #call<T>(
		provider: LlmProvider,
		call: LlmCall<T>,
		purpose: SpendPurpose,
		key: string,
		budget: CallBudget | undefined,
	): Promise<LlmAnswer<T>> {
		const now = this.#ctx.clock.now();
		const [spent, cap] =
			purpose === "import"
				? [this.importSpent(), this.#config.llm.import_usd_cap]
				: [this.#spentToday(), this.#config.llm.daily_usd_cap];
		if (spent + this.#held[purpose] >= cap) {
			this.#alerts?.raise("llm_cap", { cap_usd: cap }, { subject: purpose === "import" ? "import" : "" });
			return { ok: false, why: "cap" };
		}
		if (budget && budget.spent() + (this.#heldFor.get(budget.key) ?? 0) >= budget.usd)
			return { ok: false, why: "budget" };

		// Held against the cap until the call's real cost is recorded: ≈ 4 characters a token in, the
		// whole output limit out.
		const hold = this.#usd(
			provider.modelId,
			Math.ceil((call.system.length + call.user.length) / 4),
			call.maxOutputTokens,
		);
		this.#held[purpose] += hold;
		if (budget) this.#heldFor.set(budget.key, (this.#heldFor.get(budget.key) ?? 0) + hold);
		let reply: ProviderReply<T>;
		try {
			reply = await provider.ask(call, AbortSignal.timeout(call.timeoutMs));
		} catch (e) {
			const name = e instanceof Error ? e.name : "";
			return { ok: false, why: /timeout|abort/iu.test(name) ? "timeout" : "error" };
		} finally {
			this.#held[purpose] -= hold;
			if (budget) {
				const left = (this.#heldFor.get(budget.key) ?? 0) - hold;
				if (left > 1e-12) this.#heldFor.set(budget.key, left);
				else this.#heldFor.delete(budget.key);
			}
		}
		// Recorded in the same turn the holds are released, so no other call sees neither.
		const usd = this.#recordSpend(provider.modelId, purpose, reply.tokensIn, reply.tokensOut);
		budget?.record(usd);
		const parsed = call.schema.safeParse(reply.value);
		if (!parsed.success) return { ok: false, why: "error" };
		prepared(
			this.#ctx.db,
			`INSERT INTO extraction_cache (input_hash, prompt_version, model_id, output_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (input_hash) DO UPDATE SET output_json = excluded.output_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
		).run(key, call.promptVersion, provider.modelId, JSON.stringify(parsed.data), iso(now), iso(now + 30 * DAY_MS));
		return { ok: true, value: parsed.data, usd };
	}

	#spentToday(): number {
		const day = iso(this.#ctx.clock.now()).slice(0, 10);
		return (
			(
				prepared(this.#ctx.db, "SELECT usd FROM llm_spend WHERE day = ? AND purpose = 'live'").get(day) as
					{ usd: number } | undefined
			)?.usd ?? 0
		);
	}

	#usd(modelId: string, tokensIn: number, tokensOut: number): number {
		const price = priceOf(modelId);
		return (tokensIn * price.input_per_mtok + tokensOut * price.output_per_mtok) / 1_000_000;
	}

	#recordSpend(modelId: string, purpose: SpendPurpose, tokensIn: number, tokensOut: number): number {
		const usd = this.#usd(modelId, tokensIn, tokensOut);
		prepared(
			this.#ctx.db,
			`INSERT INTO llm_spend (day, purpose, usd, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (day, purpose) DO UPDATE SET usd = usd + excluded.usd, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
		).run(iso(this.#ctx.clock.now()).slice(0, 10), purpose, usd, tokensIn, tokensOut);
		return usd;
	}
}
