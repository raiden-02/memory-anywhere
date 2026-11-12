// A scripted stand-in for the model behind the LLM adapter: each call is answered by `script`,
// which returns the answer, or throws to play a timeout or an API error. No network, no key.

import type { LlmProvider, ProviderReply } from "../../src/llm/adapter.ts";
import type { LlmCall } from "../../src/llm/prompts.ts";

export type Script = (call: LlmCall<unknown>) => unknown;

export interface FakeProvider extends LlmProvider {
  /** Every call the adapter made, in order. */
  readonly calls: LlmCall<unknown>[];
  script: Script;
}

/** An error the adapter reads as a timeout (the SDK's abort and timeout errors have these names). */
export const timeout = (): never => {
  throw Object.assign(new Error("the model took too long"), { name: "TimeoutError" });
};

/** Answers `slot_proposal` with `slot` and `sensitive_check` with `sensitive`. */
export const answers = (o: { slot?: string; sensitive?: string }): Script => (call) =>
  call.name === "slot_proposal" ? { attribute: o.slot ?? "none" } : { sensitive_category: o.sensitive ?? "none" };

export function fakeProvider(script: Script = answers({})): FakeProvider {
  const calls: LlmCall<unknown>[] = [];
  const provider: FakeProvider = {
    modelId: "claude-haiku-5-5",
    calls,
    script,
    async ask<T>(call: LlmCall<T>): Promise<ProviderReply<T>> {
      calls.push(call as LlmCall<unknown>);
      return { value: provider.script(call as LlmCall<unknown>) as T, tokensIn: 400, tokensOut: 10 };
    },
  };
  return provider;
}
