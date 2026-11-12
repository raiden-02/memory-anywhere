// Renders packages/server/src/policy/generated.ts from packages/server/policy/: the policy version,
// every channel text of policy.md (copied byte for byte, memory-policy.md §6), the screen lexicons
// and the attribute patterns. The server imports this module instead of reading policy files at
// run time. Run through `pnpm gen`; a test fails if the committed module is stale.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readWordList } from "./policy-data.ts";

export const SENSITIVE_CATEGORIES = [
  "health", "finances", "religion", "politics", "sexual_life", "immigration", "criminal", "home_address",
] as const;

const AttributePatterns = z.array(z.strictObject({ attribute: z.string().min(1), pattern: z.string().min(1) })).min(1);

/** The `text id=…` blocks of a policy document, in order. */
export function channelBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const m of markdown.matchAll(/```text id=([a-z_-]+)\r?\n([\s\S]*?)\r?\n```/g)) {
    const [, id, text] = m;
    if (id === undefined || text === undefined) continue;
    if (blocks.has(id)) throw new Error(`duplicate policy block ${id}`);
    blocks.set(id, text);
  }
  return blocks;
}

export function policyVersion(markdown: string): string {
  const v = /^---\r?\nversion: (P\d+)\r?\n---/.exec(markdown)?.[1];
  if (!v) throw new Error("policy.md must start with front matter `version: P<n>`");
  return v;
}

export function renderPolicyTexts(policyDir: string): string {
  const md = readFileSync(join(policyDir, "policy.md"), "utf8");
  const version = policyVersion(md);
  const texts = Object.fromEntries(channelBlocks(md));

  const files = readdirSync(join(policyDir, "sensitive")).filter((f) => f.endsWith(".txt")).map((f) => basename(f, ".txt")).sort();
  const expected = [...SENSITIVE_CATEGORIES].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`policy/sensitive/ must hold exactly ${expected.join(", ")}; found ${files.join(", ")}`);
  }
  const sensitive = Object.fromEntries(SENSITIVE_CATEGORIES.map((c) => [c, readWordList(join(policyDir, "sensitive", `${c}.txt`))]));

  const attributePatterns = AttributePatterns.parse(parse(readFileSync(join(policyDir, "attribute_patterns.yaml"), "utf8")));
  for (const p of attributePatterns) new RegExp(p.pattern); // throws on an invalid pattern

  const list = (file: string) => JSON.stringify(readWordList(join(policyDir, file)));
  return [
    "// Generated from packages/server/policy/ by `pnpm gen`. Do not edit.",
    "",
    `export const POLICY_VERSION = ${JSON.stringify(version)};`,
    "",
    "/** Channel texts of memory-policy.md §6, keyed by block id, byte for byte. */",
    `export const TEXTS = ${JSON.stringify(texts, null, 2)} as const;`,
    "export type TextId = keyof typeof TEXTS;",
    "",
    `export const OVERRIDE_PHRASES: readonly string[] = ${list("override_phrases.txt")};`,
    `export const ACTION_VERBS: readonly string[] = ${list("action_verbs.txt")};`,
    `export const REMEMBER_INTENT: readonly string[] = ${list("remember_intent.txt")};`,
    `export const SHORT_LIVED: readonly string[] = ${list("short_lived.txt")};`,
    `export const PAST_MARKERS: readonly string[] = ${list("past_markers.txt")};`,
    "",
    `export const SENSITIVE_CATEGORIES = ${JSON.stringify(SENSITIVE_CATEGORIES)} as const;`,
    "export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];",
    `export const SENSITIVE_LEXICONS: Readonly<Record<SensitiveCategory, readonly string[]>> = ${JSON.stringify(sensitive, null, 2)};`,
    "",
    `export const ATTRIBUTE_PATTERNS: readonly { readonly attribute: string; readonly pattern: string }[] = ${JSON.stringify(attributePatterns, null, 2)};`,
    "",
  ].join("\n");
}
