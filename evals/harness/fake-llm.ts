// An adversarial stand-in for the product's LLM, for suite W's "LLM on" run (M2 plan P5): no key,
// no network. Every slot proposal names a single-value slot that fits the entity, so every later
// fact about the same entity lands in a slot that is already filled: the case where an LLM slot
// could supersede, if store rules 4 and 4a let it (spec-issues #53 says they must not). Every
// sensitive check answers "none", so only the slot rules are under test.

import type { LlmProvider, ProviderReply } from "../../packages/server/src/llm/adapter.ts";
import type { LlmCall } from "../../packages/server/src/llm/prompts.ts";

/** The single-value slot proposed for each entity type: a thing gets `plan`, a person `person.relation`, the user `city`. */
const ONE_SLOT: Readonly<Record<string, string>> = {
  self: "city", person: "person.relation", org: "org.relation", project: "project.goal", thing: "plan", place: "plan",
};

/** "Entity: Thomas Kyd (type thing)" → "thing"; a new entity "(new)" gets the `thing` slot, which also types it. */
function entityType(user: string): string {
  return /^Entity: .*\(type ([a-z]+)\)$/mu.exec(user)?.[1] ?? "thing";
}

export function adversarialSlots(): LlmProvider {
  return {
    modelId: "claude-haiku-5-5",
    async ask<T>(call: LlmCall<T>): Promise<ProviderReply<T>> {
      const value = call.name === "slot_proposal" ? { attribute: ONE_SLOT[entityType(call.user)] ?? "none" } : { sensitive_category: "none" };
      return { value: value as T, tokensIn: 0, tokensOut: 0 };
    },
  };
}
