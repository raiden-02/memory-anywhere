// Reason codes returned with every write outcome (write-path.md §5.2). The message goes back to
// the model in the same result, so it says what happened and, where useful, what to do next.
// One line each, no memory content, under the 300-character `message` limit.

export const REASON_MESSAGES = {
  already_stored: "this is already stored; the existing memory was kept",
  owner: "saved on the owner's own instruction",
  update: "saved as the new value; the previous one is kept as history",
  correction: "saved as a correction; the previous value is kept as an error in history",
  contested: "saved, but it conflicts with a memory from a more trusted source; both are kept until the owner decides",
  event: "saved as a time-bound event; it expires when it no longer applies",
  explicit: "saved because the user asked to remember it",
  stated_preference: "saved as the user's stated preference; it applies everywhere once the owner confirms it",
  slot_fact: "saved as a stated fact",
  user_stated: "saved because the user stated it",
  recurred: "saved because it came up again in another conversation",
  single_mention: "single mention of a taste; it is saved if it comes up again in another conversation",
  model_inferred: "not saved yet: it was inferred, not stated by the user; it is saved if it comes up again in another conversation",
  client_floor: "staged for this app: its saves are held until the same thing comes up again or the owner approves it",
  judge_not_durable: "not saved yet: it does not look useful a month from now; it is saved if it comes up again",
  instruction_needs_owner: "standing instructions about how to behave wait for the owner's approval",
  sensitive_confirmed: "saved after the user confirmed storing this sensitive memory",
  sensitive_needs_owner: "sensitive memories wait for the owner's approval before they are stored",
  sensitive_third_party: "not saved: sensitive details about other people are never stored",
  sensitive_not_requested: "not saved: sensitive details are stored only when the user explicitly asks",
  previously_forgotten: "not saved: the user asked to forget this before",
  short_lived: "not saved: this sounds temporary; use kind=event with expires_on if it matters for weeks",
  secret: "not saved: it looks like a password, key or other secret, which is never stored",
  user_declined: "not saved: the user declined",
  capture_no_llm: "staged from the user's prompt; it is saved if it comes up again in another conversation",
  unsupported_span: "not saved: the quoted words do not appear in what the user said",
  historical: "saved as history: it is older than the current value",
  imported: "imported from another app",
  imported_observation: "imported and staged; it is saved if it comes up again",
  repo_not_enabled: "memory-anywhere is not enabled for this repository; run `mema enable` here to use it",
  offline: "the memory store is unreachable; the save is queued on this PC and sent when it is back",
} as const satisfies Record<string, string>;

export type ReasonCode = keyof typeof REASON_MESSAGES;

export const REASON_CODES = Object.keys(REASON_MESSAGES) as ReasonCode[];

export function reasonMessage(code: ReasonCode): string {
  return REASON_MESSAGES[code];
}

/** Appended to the reason when coding-tool `user_words` are not in the session's prompts (write-path.md §4 step 5). */
export const USER_WORDS_NOT_FOUND_SUFFIX = "; user_words not found in your prompts";
