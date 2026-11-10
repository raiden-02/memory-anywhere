// Renders the policy files that the client also needs (secrets.yaml, stopwords.txt) into
// packages/contracts/src/generated/policy-data.ts. Redaction runs on the PC before anything is
// spooled or sent (write-path.md §3), so the client bundle must carry these patterns without
// reading files at run time. Run through `pnpm gen`; a test fails if the committed file differs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const SecretRule = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  pattern: z.string().min(1),
  flags: z.enum(["i"]).optional(),
  check: z.enum(["luhn", "mod97"]).optional(),
  near: z
    .strictObject({ pattern: z.string().min(1), flags: z.enum(["i"]).optional(), window: z.int().min(1).max(200) })
    .optional(),
});
const SecretRules = z.array(SecretRule).min(1);
export type SecretRule = z.infer<typeof SecretRule>;

/** Lines of a policy word list: one entry per line, `#` comments and blank lines skipped. */
export function readWordList(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export function readSecretRules(policyDir: string): SecretRule[] {
  const rules = SecretRules.parse(parse(readFileSync(join(policyDir, "secrets.yaml"), "utf8")));
  for (const r of rules) {
    new RegExp(r.pattern, r.flags ?? ""); // throws on an invalid pattern
    if (r.near) new RegExp(r.near.pattern, r.near.flags ?? "");
  }
  return rules;
}

export function renderPolicyData(policyDir: string): string {
  const rules = readSecretRules(policyDir);
  const stopwords = readWordList(join(policyDir, "stopwords.txt"));
  return [
    "// Generated from packages/server/policy/ by `pnpm gen`. Do not edit.",
    "",
    "export interface SecretRule {",
    "  readonly type: string;",
    "  readonly pattern: string;",
    '  readonly flags?: "i";',
    '  readonly check?: "luhn" | "mod97";',
    '  readonly near?: { readonly pattern: string; readonly flags?: "i"; readonly window: number };',
    "}",
    "",
    `export const SECRET_RULES: readonly SecretRule[] = ${JSON.stringify(rules, null, 2)};`,
    "",
    `export const STOPWORDS: readonly string[] = ${JSON.stringify(stopwords)};`,
    "",
  ].join("\n");
}
