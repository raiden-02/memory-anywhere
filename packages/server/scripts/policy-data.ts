// Renders the policy files that the client also needs (secrets.yaml, stopwords.txt, and the
// channel texts it shows or installs itself) into packages/contracts/src/generated/policy-data.ts. Redaction runs on the PC before anything is
// spooled or sent (write-path.md §3), so the client bundle must carry these patterns without
// reading files at run time. Run through `pnpm gen`; a test fails if the committed file differs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { channelBlocks, policyVersion } from "./policy-texts.ts";

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

/**
 * Texts the client needs without the server: tool descriptions for the proxy's offline tool list
 * (topology-and-ipc.md §5), the custom instructions it prints, and the skill it installs.
 */
export const CLIENT_TEXT_IDS = [
  "desc-memory_recall", "desc-memory_profile", "desc-memory_save", "desc-memory_forget", "desc-memory_status",
  "server-instructions", "custom-instruction", "custom-instruction-gemini", "skill",
] as const;

export function renderPolicyData(policyDir: string): string {
  const rules = readSecretRules(policyDir);
  const stopwords = readWordList(join(policyDir, "stopwords.txt"));
  const policy = readFileSync(join(policyDir, "policy.md"), "utf8");
  const blocks = channelBlocks(policy);
  const texts = Object.fromEntries(CLIENT_TEXT_IDS.map((id) => {
    const text = blocks.get(id);
    if (text === undefined) throw new Error(`policy.md has no text block ${id}`);
    return [id, text];
  }));
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
    `export const POLICY_VERSION = ${JSON.stringify(policyVersion(policy))};`,
    "",
    `export const CLIENT_TEXTS = ${JSON.stringify(texts, null, 2)} as const;`,
    "",
  ].join("\n");
}
