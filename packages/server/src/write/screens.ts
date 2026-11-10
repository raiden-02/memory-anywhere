// Deterministic screens (write-path.md §7), computed once per save on the verified text.
// The suppression screen needs the store and lives in suppression.ts.

import { hasSecret } from "@memory-anywhere/contracts/redact";
import { norm } from "@memory-anywhere/contracts/normalize";
import { ACTION_VERBS, OVERRIDE_PHRASES, SENSITIVE_CATEGORIES, SENSITIVE_LEXICONS, SHORT_LIVED, type SensitiveCategory } from "../policy/generated.ts";
import { lexicon } from "../policy/lexicon.ts";

const OVERRIDES = lexicon(OVERRIDE_PHRASES, "substring");
const VERBS = lexicon(ACTION_VERBS, "word");
const SHORT = lexicon(SHORT_LIVED, "word");
const SENSITIVE = SENSITIVE_CATEGORIES.map((c) => ({ category: c, lex: lexicon(SENSITIVE_LEXICONS[c], "word") }));

/**
 * Targets of the action-instruction screen (memory-policy.md §3.2 clause 2), on normalized text:
 * a URL, an email address, a file path, a shell or code fragment, a package after an install or
 * import word, or an MCP or memory tool name.
 */
const TARGETS: readonly RegExp[] = [
  /https?:\/\/|\bwww\./u, // URL
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}]{2,}/u, // email address
  /\b[a-z]:\\|(?:^|[\s(])\/[^\s/]+\/|~\//u, // file path: C:\, /seg/…, ~/
  /`|\$\(|&&|\w\s*\|\s*\w/u, // backtick, $(, &&, a pipe between words
  /;\s*(?:rm|curl|wget|bash|sh|zsh|powershell|pwsh|cmd|python|node|npm|npx|pip|git|sudo|chmod|chown|cat|echo|del|format)\b/u, // ; then a command
  /\b(?:install|import|require|npm|pip)\s+[@a-z0-9][\w./@-]*/u, // a package or module after install/import/…
  /\bmemory_|\bmcp__/u, // tool names
];

export function secretHit(texts: readonly (string | undefined)[]): boolean {
  return texts.some((t) => t !== undefined && hasSecret(t));
}

/** memory-policy.md §3.2: override phrase, or a target together with an action verb, or kind instruction. */
export function instructionHit(content: string, kind: string): boolean {
  if (kind === "instruction") return true;
  const n = norm(content);
  if (OVERRIDES.matches(n)) return true;
  return TARGETS.some((re) => re.test(n)) && VERBS.matches(n);
}

/** The first blocked category whose lexicon matches the content or the user's words (memory-policy.md §7.1). */
export function sensitiveCategory(
  texts: readonly (string | undefined)[],
  blocked: readonly SensitiveCategory[],
): SensitiveCategory | undefined {
  const normalized = texts.filter((t): t is string => t !== undefined).map(norm);
  return SENSITIVE.find((s) => blocked.includes(s.category) && normalized.some((n) => s.lex.matches(n)))?.category;
}

/** Every blocked category whose lexicon matches the text (the render-time recheck, memory-policy.md §7.2 rule 8). */
export function sensitiveCategories(text: string, blocked: readonly SensitiveCategory[]): SensitiveCategory[] {
  const n = norm(text);
  return SENSITIVE.filter((s) => blocked.includes(s.category) && s.lex.matches(n)).map((s) => s.category);
}

/** Whether a recall query mentions a category (memory-policy.md §7.2 rule 7). */
export function queryMentions(category: SensitiveCategory, query: string): boolean {
  return SENSITIVE.find((s) => s.category === category)?.lex.matches(norm(query)) ?? false;
}

/** memory-policy.md §3.6. */
export function shortLivedHit(content: string): boolean {
  return SHORT.matches(norm(content));
}
