// The LLM adapter (write-path.md §6.2): every model call the server makes goes through `Llm.ask`.
// The PC never calls an LLM. One call, in order:
//
//   provider = none ─────────────────────────────► off      (the configured no-LLM mode)
//   no key / provider not built in ──────────────► no_key   (memory_status: llm_unavailable)
//   extraction_cache hit (30 days) ──────────────► the cached answer, free and repeatable
//   today's live spend ≥ daily_usd_cap ──────────► cap      (alert llm_cap, until 00:00 UTC)
//   the model, within the call's time limit ─────► the answer, checked against its schema
//                                    └─ too slow ► timeout · anything else ► error
//
// Every failure means "behave as provider = none": callers fall back to their deterministic rule.
// Spend is estimated from the reported token counts and `prices.json`, and recorded per UTC day.

import { createHash } from "node:crypto";
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

/** A model behind the adapter: the Anthropic API in production, a scripted fake in tests. */
export interface LlmProvider {
  readonly modelId: string;
  /** Answers one call or throws. Must stop when `signal` aborts. */
  ask<T>(call: LlmCall<T>, signal: AbortSignal): Promise<ProviderReply<T>>;
}

export type LlmFailure = "off" | "no_key" | "cap" | "timeout" | "error";

export type LlmAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: LlmFailure };

interface Price {
  readonly input_per_mtok: number;
  readonly output_per_mtok: number;
}

function priceOf(modelId: string): Price {
  const price = (PRICES as unknown as Record<string, Price | undefined>)[modelId];
  if (!price) throw new Error(`no price for LLM model ${modelId} in llm/prices.json: add it with the model pin`);
  return price;
}

/** The Anthropic API through the official SDK (ADR-0007), imported only when a key is configured. */
export async function anthropicProvider(apiKey: string, modelId: string): Promise<LlmProvider> {
  priceOf(modelId);
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]);
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
        throw Object.assign(new Error(`${call.name}: no structured answer`), { name: "LlmNoAnswer", code: r.stop_reason ?? "none" });
      }
      return { value: r.parsed_output as T, tokensIn: r.usage.input_tokens, tokensOut: r.usage.output_tokens };
    },
  };
}

/**
 * The provider `[llm]` names, with the key from `MA_LLM_API_KEY` (local mode: the environment; aws
 * mode: /run/memory-anywhere/secrets.env through the unit's EnvironmentFile). Undefined without a
 * key, or for a provider this version does not build in, so the adapter reports `llm_unavailable`.
 */
export async function providerFromEnv(config: ServerConfigT, env: NodeJS.ProcessEnv): Promise<LlmProvider | undefined> {
  const key = env.MA_LLM_API_KEY?.trim();
  if (config.llm.provider !== "anthropic" || !key) return undefined;
  return anthropicProvider(key, config.llm.model || DEFAULT_MODEL);
}

export class Llm {
  readonly #ctx: StoreContext;
  readonly #config: ServerConfigT;
  readonly #provider: LlmProvider | undefined;
  readonly #alerts: Alerts | undefined;

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

  /** A model can be called: configured and a key is present. */
  get available(): boolean {
    return this.configured && this.#provider !== undefined;
  }

  /** memory_status's reason when a configured LLM cannot be used (mcp-interface.md §3.5). */
  degraded(): "llm_unavailable" | "llm_cap" | undefined {
    if (!this.configured) return undefined;
    if (!this.#provider) return "llm_unavailable";
    return this.#spentToday() >= this.#config.llm.daily_usd_cap ? "llm_cap" : undefined;
  }

  async ask<T>(call: LlmCall<T>): Promise<LlmAnswer<T>> {
    if (!this.configured) return { ok: false, why: "off" };
    const provider = this.#provider;
    if (!provider) return { ok: false, why: "no_key" };

    const key = createHash("sha256").update(`${call.user}\u0000${call.promptVersion}\u0000${provider.modelId}`, "utf8").digest("hex");
    const now = this.#ctx.clock.now();
    const cached = prepared(this.#ctx.db, "SELECT output_json FROM extraction_cache WHERE input_hash = ? AND expires_at > ? AND output_json IS NOT NULL")
      .get(key, iso(now)) as { output_json: string } | undefined;
    if (cached) {
      const parsed = call.schema.safeParse(JSON.parse(cached.output_json));
      if (parsed.success) return { ok: true, value: parsed.data };
    }

    const cap = this.#config.llm.daily_usd_cap;
    if (this.#spentToday() >= cap) {
      this.#alerts?.raise("llm_cap", { cap_usd: cap });
      return { ok: false, why: "cap" };
    }

    let reply: ProviderReply<T>;
    try {
      reply = await provider.ask(call, AbortSignal.timeout(call.timeoutMs));
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      return { ok: false, why: /timeout|abort/iu.test(name) ? "timeout" : "error" };
    }
    this.#recordSpend(provider.modelId, reply.tokensIn, reply.tokensOut);
    const parsed = call.schema.safeParse(reply.value);
    if (!parsed.success) return { ok: false, why: "error" };
    prepared(this.#ctx.db,
        `INSERT INTO extraction_cache (input_hash, prompt_version, model_id, output_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (input_hash) DO UPDATE SET output_json = excluded.output_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(key, call.promptVersion, provider.modelId, JSON.stringify(parsed.data), iso(now), iso(now + 30 * DAY_MS));
    return { ok: true, value: parsed.data };
  }

  #spentToday(): number {
    const day = iso(this.#ctx.clock.now()).slice(0, 10);
    return (prepared(this.#ctx.db, "SELECT usd FROM llm_spend WHERE day = ? AND purpose = 'live'").get(day) as { usd: number } | undefined)?.usd ?? 0;
  }

  #recordSpend(modelId: string, tokensIn: number, tokensOut: number): void {
    const price = priceOf(modelId);
    const usd = (tokensIn * price.input_per_mtok + tokensOut * price.output_per_mtok) / 1_000_000;
    prepared(this.#ctx.db,
        `INSERT INTO llm_spend (day, purpose, usd, tokens_in, tokens_out) VALUES (?, 'live', ?, ?, ?)
         ON CONFLICT (day, purpose) DO UPDATE SET usd = usd + excluded.usd, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      )
      .run(iso(this.#ctx.clock.now()).slice(0, 10), usd, tokensIn, tokensOut);
  }
}
