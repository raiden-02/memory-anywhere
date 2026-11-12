// Text normalization shared by client and server (data-model.md §1, write-path.md §6.1).
// Every comparison of saved text (duplicate detection, suppressions, overlap checks, entity
// lookup) goes through these functions, so they must stay identical on both sides.

import { createHash } from "node:crypto";
import { STOPWORDS } from "./generated/policy-data.ts";

const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS);

/**
 * `norm(text)`: Unicode NFKC, lowercase, whitespace runs collapsed to one space, trimmed,
 * trailing `.`, `!`, `?` stripped, then a leading `user ` or `i ` stripped.
 */
export function norm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trimEnd() // "likes tea ." must equal "likes tea"
    .replace(/^(?:user|i) /u, "");
}

/** Lowercase hex SHA-256 of `norm(content)`. */
export function contentNormHash(content: string): string {
  return createHash("sha256").update(norm(content), "utf8").digest("hex");
}

/**
 * Content words: tokens of `norm(text)` split on anything that is not a letter or digit,
 * without stopwords, with a trailing `s` removed from tokens longer than 3 characters.
 */
export function contentWords(text: string): string[] {
  return norm(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "" && !STOPWORD_SET.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/** Entity lookup key: `norm(x)` with `-`, `_` and `.` turned into spaces and spaces collapsed. */
export function normEntity(text: string): string {
  return norm(text).replace(/[-_.]/gu, " ").replace(/ +/gu, " ").trim();
}
