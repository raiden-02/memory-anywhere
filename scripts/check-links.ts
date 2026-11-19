// Every relative link in the repository's Markdown files points at a file or folder that exists.
// External links (http, https, mailto) and same-page anchors are not checked: the first need the
// network, and the second change with every heading edit without breaking a reader's path.
//
//   node scripts/check-links.ts      exits 1 and lists each broken link as file:line → target

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface BrokenLink {
	readonly file: string;
	readonly line: number;
	readonly target: string;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#)/iu;

/** The relative link targets in one Markdown text, with their line numbers; code blocks are skipped. */
export function relativeLinks(text: string): { line: number; target: string }[] {
	const out: { line: number; target: string }[] = [];
	let fenced = false;
	text.split("\n").forEach((content, i) => {
		if (/^\s*(```|~~~)/u.test(content)) fenced = !fenced;
		if (fenced) return;
		for (const m of content.replaceAll(/`[^`]*`/gu, "").matchAll(LINK)) {
			const target = m[1] ?? "";
			if (!EXTERNAL.test(target)) out.push({ line: i + 1, target });
		}
	});
	return out;
}

/** Broken relative links in the given Markdown files, resolved against `root`. */
export function brokenLinks(root: string, files: readonly string[]): BrokenLink[] {
	const broken: BrokenLink[] = [];
	for (const file of files) {
		const dir = path.dirname(path.join(root, file));
		for (const { line, target } of relativeLinks(readFileSync(path.join(root, file), "utf8"))) {
			const linked = decodeURIComponent(target.split("#")[0] ?? "");
			if (!existsSync(path.resolve(dir, linked))) broken.push({ file, line, target });
		}
	}
	return broken;
}

function main(): number {
	const root = path.resolve(import.meta.dirname, "..");
	const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter((f) => f && !f.startsWith("evals/datasets/") && existsSync(path.join(root, f)));
	const broken = brokenLinks(root, tracked);
	for (const b of broken) console.error(`${b.file}:${b.line} → ${b.target}`);
	if (broken.length > 0) console.error(`${broken.length} broken link(s)`);
	return broken.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
