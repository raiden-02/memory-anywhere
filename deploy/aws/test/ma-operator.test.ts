// ma-operator.sh runs in CloudShell; these tests cover only the argument checks,
// which exit before any AWS call, so they run anywhere bash exists.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOY_AWS_DIR } from "../lib/inputs.ts";
import { findBash } from "./bash.ts";

const SCRIPT = join(DEPLOY_AWS_DIR, "ma-operator.sh");

const bash = findBash();

function run(...args: string[]) {
	const r = spawnSync(bash ?? "bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, AWS_REGION: "us-east-1" },
	});
	return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!bash)("ma-operator.sh arguments", () => {
	it("prints usage for --help and lists all ten commands", () => {
		const r = run("--help");
		expect(r.code).toBe(0);
		for (const c of [
			"setup-link",
			"set-llm-key",
			"restore",
			"reset-owner",
			"acme-account",
			"import-export",
			"delete-data",
			"pause",
			"resume",
			"store-hash",
		]) {
			expect(r.out).toContain(c);
		}
	});

	it("rejects an unknown command", () => {
		const r = run("launch-missiles");
		expect(r.code).toBe(1);
		expect(r.err).toContain("unknown command launch-missiles");
	});

	it("rejects a malformed stage", () => {
		const r = run("setup-link", "--stage", "Prod");
		expect(r.code).toBe(1);
		expect(r.err).toContain("stage must be prod, spike or eval-<id>");
	});

	it("refuses delete-data without an explicit stage", () => {
		const r = run("delete-data");
		expect(r.code).toBe(1);
		expect(r.err).toContain("needs an explicit --stage");
	});

	it("rejects an unknown flag", () => {
		const r = run("acme-account", "--force");
		expect(r.code).toBe(1);
		expect(r.err).toContain("unknown argument --force");
	});
});

/**
 * A stand-in `aws` on PATH: the stack's outputs, and the setup-token parameter as the outbox
 * writes it (the plain token, with the time it was written). `send-command` (the renewal on the
 * instance) makes the next read return a fresh token, as the outbox would.
 */
function fakeAws(dir: string, token: { value: string; writtenAt: string }): void {
	const state = join(dir, "renewed");
	writeFileSync(
		join(dir, "aws"),
		`#!/bin/bash
args="$*"
case "$args" in
  *describe-stacks*InstanceId*) echo i-0123456789abcdef0 ;;
  *describe-stacks*ParameterPrefix*) echo /memory-anywhere-eval-a1 ;;
  *describe-stacks*AdminOrigin*) echo https://admin.eval.memory.example.com ;;
  *describe-stacks*) echo none ;;
  *get-parameter*setup-token*)
    if [ -f '${state}' ]; then printf 'renewed-token\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000000+00:00)"
    else printf '%s\\t%s\\n' '${token.value}' '${token.writtenAt}'; fi ;;
  *send-command*) touch '${state}'; echo cmd-1 ;;
  *"wait command-executed"*) ;;
  *get-command-invocation*Status*) echo Success ;;
  *get-command-invocation*) echo '{"ok":true}' ;;
  *) echo "unexpected aws call: $args" >&2; exit 2 ;;
esac
`,
		{ mode: 0o755 },
	);
}

describe.skipIf(!bash || process.platform === "win32")("ma-operator.sh setup-link", () => {
	const link = (token: { value: string; writtenAt: string }) => {
		const dir = mkdtempSync(join(tmpdir(), "ma operator "));
		try {
			fakeAws(dir, token);
			const r = spawnSync(bash ?? "bash", [SCRIPT, "setup-link", "--stage", "eval-a1"], {
				encoding: "utf8",
				env: { ...process.env, AWS_REGION: "us-east-1", PATH: `${dir}:${process.env["PATH"] ?? ""}` },
			});
			return { code: r.status, out: r.stdout, err: r.stderr };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("prints the link for a fresh token, read as the plain text the outbox stores", () => {
		const written = new Date(Date.now() - 60_000);
		const r = link({ value: "tok_fresh-123", writtenAt: written.toISOString() });
		expect(r.err).toBe("");
		expect(r.out).toContain("https://admin.eval.memory.example.com/setup#tok_fresh-123");
		expect(r.out).toContain(`valid until ${new Date(written.getTime() + 30 * 60_000).toISOString().slice(0, 19)}Z`);
		expect(r.out).not.toContain("issuing a fresh");
	});

	it("renews a token written more than 29 minutes ago, then prints the new one", () => {
		const r = link({ value: "tok_old", writtenAt: new Date(Date.now() - 40 * 60_000).toISOString() });
		expect(r.code).toBe(0);
		expect(r.out).toContain("issuing a fresh 30-minute token");
		expect(r.out).toContain("/setup#renewed-token");
		expect(r.out).not.toContain("tok_old");
	});
});
