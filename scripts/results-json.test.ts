// Every committed result file must parse: scrubbing once corrupted decimal numbers in eval results
// (the scrubber's account-id rule matched fraction digits). The report is how a reader finds the
// results, so it must cite every data file and link only to files that exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RESULTS = join(import.meta.dirname, "..", "docs", "results");
const DATA = join(RESULTS, "data");
const REPORT = join(RESULTS, "report.md");

function jsonFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return jsonFiles(p);
		return name.endsWith(".json") ? [p] : [];
	});
}

/** Absolute paths of the report's relative Markdown links, without their #fragment. */
function reportLinks(): string[] {
	const text = readFileSync(REPORT, "utf8");
	return [...text.matchAll(/\]\(([^)\s]+)\)/gu)]
		.map((m) => (m[1] ?? "").split("#")[0] ?? "")
		.filter((target) => target !== "" && !/^[a-z]+:/iu.test(target))
		.map((target) => resolve(dirname(REPORT), decodeURI(target)));
}

const rel = (p: string): string => relative(RESULTS, p).replaceAll("\\", "/");

describe("docs/results", () => {
	it("keeps the result files in data/", () => {
		expect(jsonFiles(DATA).length).toBeGreaterThan(0);
	});

	it.each(jsonFiles(RESULTS).map((f) => [rel(f)]))("%s parses", (file) => {
		expect(() => JSON.parse(readFileSync(join(RESULTS, file), "utf8"))).not.toThrow();
	});

	it("report.md cites every data file", () => {
		const linked = new Set(reportLinks());
		expect(
			jsonFiles(DATA)
				.filter((f) => !linked.has(f))
				.map(rel),
		).toEqual([]);
	});

	it("report.md links only to files that exist", () => {
		expect(
			reportLinks()
				.filter((p) => !existsSync(p))
				.map(rel),
		).toEqual([]);
	});
});
