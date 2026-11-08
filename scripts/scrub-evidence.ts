// Rewrites evidence files in place so nothing owner-specific reaches the public
// repo: the owner's hostname (MA_DOMAIN), AWS account ids, email addresses and
// anything that looks like a credential. Prints counts only, never values.
//
//   node scripts/scrub-evidence.ts <file-or-dir> [...]
//
// Run before staging anything under docs/results/evidence/. The commit hooks
// and the CI OWNER_HOST check are the backstop, not the primary control.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ScrubCounts {
  domain: number;
  accountIds: number;
  emails: number;
  secrets: number;
}

export interface ScrubResult {
  text: string;
  counts: ScrubCounts;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Placeholder addresses used throughout the spec stay as they are.
const KEEP_EMAIL_DOMAINS = new Set(["example.com", "example.org", "anthropic.com", "memory-anywhere.invalid"]);

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1<redacted-token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<aws-access-key-id>"],
  [/("(?:SecretAccessKey|SessionToken|accessToken|refresh_token|access_token|client_secret)"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2"],
];

export function scrub(input: string, opts: { domain: string }): ScrubResult {
  const domain = opts.domain.trim();
  if (domain.length < 4 || !domain.includes(".")) {
    throw new Error("scrub: MA_DOMAIN does not look like a hostname");
  }
  const counts: ScrubCounts = { domain: 0, accountIds: 0, emails: 0, secrets: 0 };
  let text = input;

  for (const [re, replacement] of SECRET_PATTERNS) {
    counts.secrets += text.match(re)?.length ?? 0;
    text = text.replace(re, replacement);
  }

  text = text.replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (match, host: string) => {
    if (KEEP_EMAIL_DOMAINS.has(host.toLowerCase())) return match;
    counts.emails++;
    return "<email>";
  });

  // Subdomains such as spike.<domain> become spike.{host}.
  text = text.replace(new RegExp(escapeRegExp(domain), "gi"), () => {
    counts.domain++;
    return "{host}";
  });

  // A standalone 12-digit run, but not the fraction of a decimal number (0.123456789012) nor the
  // integer part of one: scrubbing those corrupted eval result files.
  text = text.replace(/(?<![0-9])(?<![0-9]\.)[0-9]{12}(?![0-9])(?!\.[0-9])/g, () => {
    counts.accountIds++;
    return "<aws-account-id>";
  });

  return { text, counts };
}

function filesUnder(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((d) => filesUnder(path.join(target, d.name)));
}

function main(argv: readonly string[]): number {
  const domain = process.env["MA_DOMAIN"] ?? "";
  if (!domain) {
    console.error("scrub-evidence: MA_DOMAIN is not set; refusing to run without it.");
    return 1;
  }
  if (argv.length === 0) {
    console.error("usage: node scripts/scrub-evidence.ts <file-or-dir> [...]");
    return 1;
  }
  for (const file of argv.flatMap(filesUnder)) {
    const before = readFileSync(file, "utf8");
    const { text, counts } = scrub(before, { domain });
    if (text !== before) writeFileSync(file, text);
    const total = counts.domain + counts.accountIds + counts.emails + counts.secrets;
    console.log(`${total === 0 ? "clean   " : "scrubbed"} ${file} ${JSON.stringify(counts)}`);
  }
  return 0;
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
