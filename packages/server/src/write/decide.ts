// Step 5, the policy decision table (write-path.md §5). A pure function: every input is computed
// before (verification, screens, resolution, the duplicate lookup), so each row can be tested in a
// table. Rows are evaluated top to bottom; the first that matches decides.
//
// Elicitation (rows D5, D7, D15): when the caller can ask the human, the first call returns
// `elicit` with the question; the retry carries the answer. In local mode no client can elicit, so
// these rows always take their "else" branch.

import type { KindT } from "@memory-anywhere/contracts/schemas/common";
import type { Decision, Resolution, Screens, TierNum, Verified } from "./types.ts";

export interface DecideInput {
  readonly tier: TierNum;
  readonly channel: "mcp" | "spool_save" | "capture" | "admin";
  readonly kind: KindT;
  readonly explicitRequest: boolean;
  readonly supersedes: string | undefined;
  readonly verified: Pick<Verified, "content" | "qualifyingUserWords" | "rememberIntent">;
  readonly screens: Screens;
  readonly resolution: Resolution;
  /** D10: an active or contested memory in the caller's scope whose current version has this content hash. */
  readonly duplicateOf: string | undefined;
  /** D11: client_policy.save_floor = observation. */
  readonly floored: boolean;
  readonly canElicit: boolean;
  readonly elicitationAnswer: boolean | undefined;
}

/** The quoted part of an elicitation question: the first 200 characters of the content. */
export function quote(content: string): string {
  const head = [...content].slice(0, 200).join("");
  return `“${head.replace(/[“”]/g, '"')}”`;
}

export function decide(i: DecideInput): Decision {
  const owner = i.tier === 0;
  const s = i.screens;
  const q = i.verified;
  const ask = i.canElicit && i.elicitationAnswer === undefined;

  // D1: secrets are never stored, at any tier.
  if (s.secretHit) return { row: "D1", kind: "reject", reason: "secret" };
  // D2: anything that directs the assistant to act waits for the owner (not at T0).
  if (!owner && s.instructionHit) return { row: "D2", kind: "review", reason: "instruction_needs_owner", reviewKind: "instruction" };
  if (s.sensitiveCategory) {
    // D3: sensitive details about other people, at any tier.
    if (i.resolution.entity.type !== "self" || i.resolution.isPeopleSection) return { row: "D3", kind: "reject", reason: "sensitive_third_party" };
    // D4: the owner may store sensitive facts about themselves.
    if (owner) return { row: "D4", kind: "active", reason: "explicit", tier: 0, preferenceConfirm: false };
    // D5: a claimed request needs the human's Yes, else the owner's approval.
    if (i.explicitRequest || q.rememberIntent) {
      if (ask) return { row: "D5", kind: "elicit", question: `Store this sensitive memory (${s.sensitiveCategory}) for all your AI apps: ${quote(q.content)}?` };
      if (i.canElicit && i.elicitationAnswer === true) return { row: "D5", kind: "active", reason: "sensitive_confirmed", tier: 1, preferenceConfirm: false };
      if (i.canElicit && i.elicitationAnswer === false) return { row: "D5", kind: "reject", reason: "user_declined" };
      return { row: "D5", kind: "review", reason: "sensitive_needs_owner", reviewKind: "sensitive" };
    }
    // D6: otherwise sensitive content is not stored.
    return { row: "D6", kind: "reject", reason: "sensitive_not_requested" };
  }
  let tier = i.tier;
  if (!owner && s.suppressionHit) {
    // D7: the human may confirm saving something forgotten before; Yes continues from D9 at T1.
    if (i.channel === "mcp" && i.canElicit) {
      if (ask) return { row: "D7", kind: "elicit", question: `You asked to forget this before. Save it again: ${quote(q.content)}?` };
      if (i.elicitationAnswer !== true) return { row: "D7", kind: "reject", reason: "previously_forgotten" };
      tier = 1;
    } else {
      // D8
      return { row: "D8", kind: "reject", reason: "previously_forgotten" };
    }
  }
  // D9: short-lived wording, unless it is saved as an event (not at T0: the owner's word is final).
  if (!owner && s.shortLivedHit && i.kind !== "event") return { row: "D9", kind: "reject", reason: "short_lived" };
  // D10: already stored in the caller's scope.
  if (i.duplicateOf) return { row: "D10", kind: "already_stored", memoryId: i.duplicateOf };
  // D10a: the owner's save is stored as given.
  if (owner) return { row: "D10a", kind: "active", reason: "owner", tier: 0, preferenceConfirm: false };
  // D11: floored clients stage everything at T2 and below.
  if (i.floored && tier >= 2) return { row: "D11", kind: "observation", reason: "client_floor", floored: true };
  // D12: an explicit supersede goes through store rule 0, which may make it contested.
  if (i.supersedes) return { row: "D12", kind: "active", reason: "update", tier, preferenceConfirm: false };
  if (i.kind === "event") {
    // D13 / D13b: an event the user stated is stored; an inferred one is staged.
    if (q.qualifyingUserWords) return { row: "D13", kind: "active", reason: "event", tier, preferenceConfirm: false };
    return { row: "D13b", kind: "observation", reason: "model_inferred", floored: false };
  }
  // D14: an explicit request in the user's own words.
  if (i.explicitRequest && q.rememberIntent && q.qualifyingUserWords) return { row: "D14", kind: "active", reason: "explicit", tier, preferenceConfirm: false };
  // D15: a stated preference applies at once; the owner confirms it for the profile.
  if (i.kind === "preference" && q.qualifyingUserWords) {
    if (ask) return { row: "D15", kind: "elicit", question: `Apply this preference in all your AI apps: ${quote(q.content)}?` };
    if (i.canElicit && i.elicitationAnswer === true) return { row: "D15", kind: "active", reason: "stated_preference", tier: 1, preferenceConfirm: false };
    if (i.canElicit && i.elicitationAnswer === false) return { row: "D15", kind: "reject", reason: "user_declined" };
    return { row: "D15", kind: "active", reason: "stated_preference", tier, preferenceConfirm: true };
  }
  // D16: a stated fact that fills a registry slot.
  if (i.resolution.attribute && !i.resolution.tasteClass && q.qualifyingUserWords) return { row: "D16", kind: "active", reason: "slot_fact", tier, preferenceConfirm: false };
  // D17: a single mention of a taste is staged until it recurs.
  if (i.resolution.tasteClass) return { row: "D17", kind: "observation", reason: "single_mention", floored: false };
  // D18: anything else the user stated.
  if (q.qualifyingUserWords) return { row: "D18", kind: "active", reason: "user_stated", tier, preferenceConfirm: false };
  // D19: model inferences are staged until they recur.
  return { row: "D19", kind: "observation", reason: "model_inferred", floored: false };
}
