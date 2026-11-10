// Step 4, normalize and verify (write-path.md §4; memory-policy.md §3.4–§3.5).

import { contentNormHash, contentWords, norm } from "@memory-anywhere/contracts/normalize";
import { REMEMBER_INTENT } from "../policy/generated.ts";
import { lexicon } from "../policy/lexicon.ts";
import { WriteError, type Verified } from "./types.ts";

const REMEMBER = lexicon(REMEMBER_INTENT, "substring");

/** Control and format characters (Unicode Cc, Cf), except the zero-width joiner. */
const CONTROL_RUN = /(?:(?!‍)[\p{Cc}\p{Cf}])+/gu;

/** Step 1: each run of control characters becomes one space; the result is trimmed. */
export function stripControl(text: string): string {
  return text.replace(CONTROL_RUN, " ").trim();
}

/** |content words of content ∩ content words of user_words| / |content words of content|. */
export function support(userWords: string, content: string): number {
  const c = new Set(contentWords(content));
  if (c.size === 0) return 0;
  const u = new Set(contentWords(userWords));
  let shared = 0;
  for (const w of c) if (u.has(w)) shared++;
  return shared / c.size;
}

/** memory-policy.md §3.5: at least 3 words and support ≥ support_min. */
export function isQualifying(userWords: string | undefined, content: string, supportMin: number): boolean {
  if (!userWords) return false;
  const words = norm(userWords).split(" ").filter((w) => w !== "");
  return words.length >= 3 && support(userWords, content) >= supportMin;
}

export function hasRememberIntent(userWords: string | undefined): boolean {
  return userWords !== undefined && REMEMBER.matches(norm(userWords));
}

export interface VerifyInput {
  readonly content: string;
  readonly why_durable: string;
  readonly user_words?: string | undefined;
}

export interface VerifyOptions {
  readonly supportMin: number;
  /**
   * Coding callers only: resolves true when `norm(user_words)` occurs in one of the session's
   * prompts (step 5, with its own 1.5 s re-check). Undefined for other callers.
   */
  readonly findInPrompts: ((normalizedUserWords: string) => Promise<boolean>) | undefined;
}

export async function verify(input: VerifyInput, o: VerifyOptions): Promise<Verified> {
  const content = stripControl(input.content);
  const whyDurable = stripControl(input.why_durable);
  let userWords = input.user_words === undefined ? undefined : stripControl(input.user_words);
  if (userWords === "") userWords = undefined;

  if (content.length < 1 || content.length > 400) throw new WriteError("INVALID_INPUT", "content must be 1–400 characters", "content");
  if (whyDurable.length < 1 || whyDurable.length > 200) throw new WriteError("INVALID_INPUT", "why_durable must be 1–200 characters", "why_durable");
  if (userWords !== undefined && userWords.length > 200) throw new WriteError("INVALID_INPUT", "user_words must be at most 200 characters", "user_words");

  let userWordsUnsupported = false;
  if (userWords !== undefined && o.findInPrompts && !(await o.findInPrompts(norm(userWords)))) {
    userWords = undefined; // treated as absent for every rule below
    userWordsUnsupported = true;
  }

  return {
    content,
    userWords,
    whyDurable,
    contentHash: contentNormHash(content),
    qualifyingUserWords: isQualifying(userWords, content, o.supportMin),
    rememberIntent: hasRememberIntent(userWords),
    userWordsUnsupported,
  };
}
