// `pnpm check:repo`: text that must never be committed to this public repository. Runs in
// `pnpm check`, in CI, and in the pre-commit hook (`--staged`, on what is about to be committed).
//
//   personal data   cloud resource ids, account ids, IP addresses, local user paths, email
//                   addresses, the owner's hostname (MA_DOMAIN, OWNER_HOST) and private words
//                   such as a name or machine name (MA_PRIVATE_TERMS, comma-separated)
//   process notes   in code, tests and config only: issue numbers, milestone names and dated
//                   decisions, which belong in the pull request; a comment explains the code instead
//
// Documentation placeholders pass: example.com addresses, the reserved documentation IP ranges,
// all-zero or counting ids (i-0123456789abcdef0, 111111111111) and the fixture users "Ann Lee",
// "ann", "me" and "owner". Cloudflare's published ranges pass too: they are public infrastructure.
//
//   node scripts/check-repo.ts [--staged]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CLOUDFLARE_V4 } from "../packages/client/src/deploy/dns.ts";

export interface Finding {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
}

interface Rule {
	readonly name: string;
	readonly pattern: RegExp;
	/** True when the match is a placeholder or public value, not personal data. */
	readonly allowed?: (match: string) => boolean;
}

const ALLOW_MARK = "check-repo: allow";
/** A whole id that is a documentation placeholder: counting hex (0123456789abcdef0) or all zeros or fs. */
const PLACEHOLDER_HEX = /^(0123456789abcdef0?|0+|f+)$/u;
const PLACEHOLDER_ACCOUNTS = new Set(["111111111111", "123456789012", "000000000000"]);
const FIXTURE_USERS = new Set(["ann", "me", "owner", "runner", "user", "<user>", "%username%", "$user"]);
const EMAIL_DOMAINS =
	/(^|\.)(example\.(com|org|net)|invalid|test|github\.com|users\.noreply\.github\.com|anthropic\.com|chatgpt\.com)$/iu;

function ipv4(text: string): number[] | undefined {
	const parts = text.split(".").map(Number);
	return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
}

function inCidr(ip: number[], cidr: string): boolean {
	const [base, bits] = cidr.split("/") as [string, string];
	const b = ipv4(base);
	if (!b) return false;
	const toInt = (p: number[]): number => p.reduce((n, octet) => n * 256 + octet, 0);
	const block = 2 ** (32 - Number(bits));
	return Math.floor(toInt(ip) / block) === Math.floor(toInt(b) / block);
}

/** Private, loopback, link-local, documentation and Cloudflare ranges: none of them identifies anyone. */
const PUBLIC_OK_RANGES = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"255.255.255.255/32",
	"1.1.1.1/32",
	"8.8.8.8/32",
	...CLOUDFLARE_V4,
];

export function rules(env: NodeJS.ProcessEnv = process.env): Rule[] {
	// Words no pattern can recognise (a name, a machine name), kept in the environment, never in the repository.
	const privateTerms = (env["MA_PRIVATE_TERMS"] ?? "").split(",");
	const hosts = [env["MA_DOMAIN"], env["OWNER_HOST"], ...privateTerms]
		.map((h) => h?.trim())
		.filter((h): h is string => !!h);
	return [
		{
			name: "AWS instance id",
			pattern: /\bi-[0-9a-f]{17}\b/gu,
			allowed: (m) => PLACEHOLDER_HEX.test(m.slice(2)),
		},
		{
			name: "AWS Identity Center id",
			pattern: /\b(ssoins|ps|d)-[0-9a-f]{10,16}\b/gu,
			allowed: (m) => PLACEHOLDER_HEX.test(m.split("-")[1] ?? ""),
		},
		{
			name: "AWS SSO role suffix",
			pattern: /AWSReservedSSO_[A-Za-z0-9-]+_[0-9a-f]{16}\b/gu,
			allowed: (m) => PLACEHOLDER_HEX.test(m.slice(-16)),
		},
		{
			name: "AWS account id",
			pattern: /arn:aws:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}/gu,
			allowed: (m) => PLACEHOLDER_ACCOUNTS.has(m.slice(-12)),
		},
		{
			name: "IP address",
			pattern: /(?<![\d.])\d{1,3}(\.\d{1,3}){3}(?![\d.]*\d)(?!\/\d)/gu,
			allowed: (m) => {
				const ip = ipv4(m);
				return !ip || PUBLIC_OK_RANGES.some((r) => inCidr(ip, r));
			},
		},
		{
			name: "local user path",
			pattern: /(?:^|[\\/:"'])(?:Users|home)[\\/]+([^\\/"'\s`]+)/gu,
			allowed: (m) => {
				const user = (m.split(/[\\/]+/u).pop() ?? "").toLowerCase();
				return FIXTURE_USERS.has(user) || /^[.…]|[${]/u.test(user);
			},
		},
		{
			name: "email address",
			pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\b/gu,
			allowed: (m) => /@\d/u.test(m) || EMAIL_DOMAINS.test(m.split("@")[1] ?? ""),
		},
		...hosts.map((h) => ({
			name: "private term (MA_DOMAIN, OWNER_HOST or MA_PRIVATE_TERMS)",
			pattern: new RegExp(h.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"),
		})),
	];
}

// Patterns are assembled from parts so that this file does not match itself.
const PROCESS_RULES: Rule[] = [
	{ name: "issue number", pattern: new RegExp(["spec", "-issues"].join(""), "gu") },
	{ name: "milestone name", pattern: /(?<![\w.-])M[0-5](?![\w.-])/gu },
	{ name: "dated decision", pattern: new RegExp(["owner", " decision"].join(""), "giu") },
];
/** Source and configuration files, where only the code's own reasons belong: code, scripts, workflows, hooks and root config. */
const CODE =
	/^(?:(?:packages|deploy|evals(?!\/datasets\/)|scripts|config|plugins|\.github)\/(?:.*\.(?:ts|mjs|js|sh|py|sql|json|eta|ya?ml)|(?:.*\/)?Dockerfile)|\.githooks\/[^/]+|[^/]+\.(?:ts|mjs|json|ya?ml))$/u;

/** The rules for one file: personal data everywhere, process notes in source files too. */
export function rulesFor(file: string, env: NodeJS.ProcessEnv = process.env): Rule[] {
	return CODE.test(file) ? [...rules(env), ...PROCESS_RULES] : rules(env);
}

/** Every finding in `text`, a file's content. */
export function scan(file: string, text: string, all: Rule[] = rules()): Finding[] {
	const found: Finding[] = [];
	text.split("\n").forEach((line, i) => {
		// A test that needs a realistic value to prove it gets scrubbed marks its line.
		if (line.includes(ALLOW_MARK)) return;
		for (const rule of all) {
			for (const m of line.matchAll(rule.pattern)) {
				if (!rule.allowed?.(m[0].trim())) found.push({ file, line: i + 1, rule: rule.name });
			}
		}
	});
	return found;
}

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

/** Tracked text files (or, with `staged`, the index's version of each staged file). */
export function checkRepo(staged: boolean): Finding[] {
	const files = (staged ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]) : git(["ls-files"]))
		.split("\n")
		.filter((f) => f && f !== "pnpm-lock.yaml" && !/\.(png|ico|db|onnx|gz)$/u.test(f));
	return files.flatMap((f) => {
		let text: string;
		try {
			text = staged ? git(["show", `:${f}`]) : readFileSync(f, "utf8");
		} catch {
			return []; // deleted in the working tree
		}
		return text.includes("\0") ? [] : scan(f, text, rulesFor(f));
	});
}

if (import.meta.main) {
	const found = checkRepo(process.argv.includes("--staged"));
	// Only the place and the kind are printed, never the matched text: the hostname must not reach a log.
	for (const f of found) console.error(`${f.file}:${f.line}: ${f.rule}`);
	if (found.length > 0) {
		console.error(
			`check-repo: ${found.length} finding(s); use placeholders (memory.example.com, i-0123456789abcdef0) and keep process notes out of code.`,
		);
		process.exit(1);
	}
}
