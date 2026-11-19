import { describe, expect, it } from "vitest";
import { rules, rulesFor, scan } from "./check-repo.ts";

// The leaked shapes are assembled at run time so this file itself passes the check.
const join = (...parts: string[]): string => parts.join("");
const kinds = (text: string, env: NodeJS.ProcessEnv = {}): string[] =>
	scan("f.md", text, rules(env)).map((f) => f.rule);

describe("check-repo", () => {
	it("finds the personal data shapes that once reached the repository", () => {
		expect(kinds(join("old instance i-", "0f1e2d3c4b5a69788"))).toEqual(["AWS instance id"]);
		expect(kinds(join("ssoins-", "9a8b7c6d5e4f3a2b"))).toEqual(["AWS Identity Center id"]);
		expect(kinds(join("Elastic IP ", "54.210", ".33.71"))).toEqual(["IP address"]);
		expect(kinds(join("C:\\Users\\", "someone", "\\Desktop"))).toEqual(["local user path"]);
		expect(kinds(join("arn:aws:iam::", "210987", "654321", ":role/x"))).toEqual(["AWS account id"]);
		expect(kinds(join("mail me at someone@", "gmail.com"))).toEqual(["email address"]);
	});

	it("finds the owner's hostname and private words, from the environment only", () => {
		const env = { MA_DOMAIN: "memory.secret.dev", MA_PRIVATE_TERMS: "Ada, AdaPC" };
		expect(kinds("see https://memory.secret.dev/v1", env)).toEqual([
			"private term (MA_DOMAIN, OWNER_HOST or MA_PRIVATE_TERMS)",
		]);
		expect(kinds("synced from adapc today", env)).toHaveLength(2);
		expect(kinds("see https://memory.secret.dev/v1")).toEqual([]);
	});

	it("passes documentation placeholders, private ranges and Cloudflare's public ranges", () => {
		const fine = [
			"i-0123456789abcdef0",
			"arn:aws:iam::111111111111:role/x",
			"AWSReservedSSO_memory-anywhere-deploy_0123456789abcdef/ma-deploy",
			"127.0.0.1 10.0.0.5 169.254.169.254 192.0.2.10 203.0.113.7 104.16.1.1",
			"173.245.48.0/20",
			"C:\\Users\\Ann Lee\\AppData /home/ann/.config /Users/…/x ~/home/.claude",
			"you+ma-aws@example.com owner@memory-anywhere.invalid pnpm@12.18.0",
			"/tmp/ma home/client.toml",
		];
		for (const text of fine) expect(kinds(text), text).toEqual([]);
	});

	it("keeps process notes out of source files, and leaves the docs alone", () => {
		const note = join("// stores only the number (spec", "-issues #108, decided in M", "4)");
		expect(scan("packages/server/src/a.ts", note, rulesFor("packages/server/src/a.ts", {})).map((f) => f.rule)).toEqual(
			["issue number", "milestone name"],
		);
		for (const config of [
			"pnpm-workspace.yaml",
			".github/workflows/ci.yml",
			".githooks/pre-commit",
			"evals/adapters/mem0/Dockerfile",
			"evals/adapters/mem0/driver.py",
		])
			expect(scan(config, note, rulesFor(config, {})).length, config).toBe(2);
		expect(scan("docs/results/report.md", note, rulesFor("docs/results/report.md", {}))).toEqual([]);
		expect(scan("evals/datasets/x.ts", note, rulesFor("evals/datasets/x.ts", {}))).toEqual([]);
	});

	it("skips a line marked as an intentional fixture", () => {
		expect(kinds(join("someone@", "gmail.com // check-repo: allow"))).toEqual([]);
	});
});
