// Size budgets per channel (memory-policy.md §5), counted in Unicode code points. A contract test
// checks every generated text against them; CI fails on an overrun.

import type { TextId } from "./generated.ts";

export interface Budget {
  /** Maximum length in code points. */
  readonly max: number;
  /** The first N code points must hold the trigger sentence (tool search matches on them). */
  readonly triggerWithin?: number;
  /** The first paragraph must stand alone within N code points (OpenAI cuts after 512). */
  readonly selfContainedWithin?: number;
  /** Maximum number of lines (Cursor rules). */
  readonly maxLines?: number;
}

export const BUDGETS: Readonly<Record<TextId, Budget>> = {
  "server-instructions": { max: 2000, selfContainedWithin: 512 },
  "desc-memory_save": { max: 2000, triggerWithin: 200 },
  "desc-memory_recall": { max: 1000, triggerWithin: 200 },
  "desc-memory_profile": { max: 600 },
  "desc-memory_forget": { max: 500 },
  "desc-memory_status": { max: 400 },
  "profile-header": { max: 600 },
  "session-preamble": { max: 400 },
  "cursor-rule": { max: 1500, maxLines: 40 },
  skill: { max: 4000 },
  "custom-instruction": { max: 700 },
  "custom-instruction-gemini": { max: 700 },
  "extractor-prompt": { max: 3000 },
};

/** Skill front matter limits: description ≤ 1,000, body ≤ 3,000 (memory-policy.md §5). */
export const SKILL_DESCRIPTION_MAX = 1000;
export const SKILL_BODY_MAX = 3000;

export function codePoints(text: string): number {
  return [...text].length;
}
