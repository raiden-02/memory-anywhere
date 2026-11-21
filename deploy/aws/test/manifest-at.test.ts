// libexec/manifest-at.sh picks the manifest a restore is checked against (deployment-aws.md §5.5).
// A stand-in `aws` on PATH answers the listing and the download, so the choice runs anywhere bash
// and python3 exist.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEPLOY_AWS_DIR } from "../lib/inputs.ts";
import { findBash } from "./bash.ts";

const SCRIPT = join(DEPLOY_AWS_DIR, "host", "release", "libexec", "manifest-at.sh");

const bash = findBash();
const python = bash
	? spawnSync(bash, ["-c", "python3 -c 'print(1)'"], { encoding: "utf8" }).stdout.trim() === "1"
	: false;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the script against a bucket listing; `aws s3 cp` writes the key's name as the manifest. */
function pick(listing: unknown, to: string): { code: number | null; out: string; manifest: string } {
	const dir = mkdtempSync(join(tmpdir(), "ma manifest-at "));
	dirs.push(dir);
	writeFileSync(
		join(dir, "stack.env"),
		"MA_REGION=us-east-1\nMA_BACKUP_BUCKET=memory-anywhere-backup-111122223333-us-east-1-eval-x\n",
	);
	writeFileSync(join(dir, "listing.json"), JSON.stringify(listing));
	writeFileSync(
		join(dir, "aws"),
		[
			"#!/bin/bash",
			'case "$3 $4" in',
			'  "s3api list-objects-v2") [ "$6" = memory-anywhere-manifest-111122223333-us-east-1-eval-x ] || exit 9; cat "$(dirname "$0")/listing.json" ;;',
			'  "s3 cp") printf \'"%s"\' "$6" > "$7" ;;',
			"  *) exit 8 ;;",
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const out = join(dir, "restored-manifest.json");
	const r = spawnSync(bash ?? "bash", [SCRIPT, to, out], {
		encoding: "utf8",
		env: { ...process.env, MA_STACK_ENV: join(dir, "stack.env"), PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
	});
	return {
		code: r.status,
		out: r.stdout + r.stderr,
		manifest: existsSync(out) ? readFileSync(out, "utf8").trim() : "",
	};
}

const obj = (date: string, at: string) => ({ Key: `manifests/manifest-${date}.json`, LastModified: at });
const LISTING = {
	Contents: [
		obj("2026-11-18", "2026-11-18T12:00:03+00:00"),
		obj("2026-11-20", "2026-11-20T12:00:02+00:00"),
		obj("2026-11-19", "2026-11-19T12:00:01+00:00"),
		{ Key: "manifests/notes.txt", LastModified: "2026-11-21T00:00:00+00:00" },
	],
};

// Each case starts bash and python3 several times, slow on Windows runners.
describe.skipIf(!bash || !python)("manifest-at.sh", { timeout: 30_000 }, () => {
	it("checks a restore to the latest backup against the newest manifest", () => {
		const r = pick(LISTING, "");
		expect(r.code).toBe(0);
		expect(r.manifest).toBe(
			'"s3://memory-anywhere-manifest-111122223333-us-east-1-eval-x/manifests/manifest-2026-11-20.json"',
		);
	});

	it("checks a point-in-time restore against the newest manifest stored by that point", () => {
		expect(pick(LISTING, "2026-11-19T12:00:00Z").manifest).toContain("manifest-2026-11-18.json");
		expect(pick(LISTING, "2026-11-19T12:00:01Z").manifest).toContain("manifest-2026-11-19.json");
	});

	it("writes null when no manifest was stored by then", () => {
		expect(pick(LISTING, "2026-11-01T00:00:00Z").manifest).toBe("null");
		expect(pick({}, "").manifest).toBe("null");
	});
});
