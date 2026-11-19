// Suite I's dataset and harness, without the model files: the labels and the scripted extractor
// agree with the fixtures, and the suite runs end to end with the server tests' word-bucket embedder
// (the gate itself runs with the pinned model: `pnpm eval run --suite I`).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeEmbedder } from "../../packages/server/test/helpers/store.ts";
import type { LlmCall } from "../../packages/server/src/llm/prompts.ts";
import {
	DATA_DIR,
	fixtures,
	loadLabels,
	loadScript,
	readFixture,
	runSuiteI,
	scriptedExtractor,
} from "../harness/suite-i.ts";

describe("suite I dataset", () => {
	const labels = loadLabels();

	it("labels files that exist; each pair file gives one item per labelled fact, the same facts or distinct ones line for line", () => {
		for (const l of labels) expect(existsSync(join(DATA_DIR, "imports", l.file)), l.file).toBe(true);
		const pair = fixtures(labels).filter((f) => f.labels[0]?.pair !== undefined);
		expect(pair.map((f) => f.source).sort()).toEqual([
			"chatgpt-memory",
			"chatgpt-memory",
			"claude-memory",
			"claude-memory",
		]);
		for (const f of pair) expect(readFixture(f).result.items).toHaveLength(f.labels[0]?.facts.length ?? -1);
		const same = pair.filter((f) => !f.labels[0]?.distinct);
		expect(same[0]?.labels[0]?.facts).toEqual(same[1]?.labels[0]?.facts);
		const distinct = pair.filter((f) => f.labels[0]?.distinct).map((f) => f.labels[0]?.facts ?? []);
		expect(distinct[0]?.length).toBeGreaterThanOrEqual(20);
		expect(distinct[0]?.some((x, i) => x === distinct[1]?.[i])).toBe(false);
	});

	it("scripts every labelled fact of each extract source, and noise beside them", () => {
		const script = loadScript();
		for (const l of labels.filter((x) =>
			["chatgpt-history", "claude-history", "chatgpt-memory-summary", "gemini-memory-summary"].includes(x.source_type),
		)) {
			const items = script[l.source_type] ?? [];
			expect(
				items
					.map((s) => s.label)
					.filter((x) => x !== null)
					.sort(),
			).toEqual([...l.facts].sort());
			expect(items.some((s) => s.label === null)).toBe(true);
		}
	});
});

describe("scripted extractor", () => {
	it("answers an item in the message holding its anchor, and nothing else", async () => {
		const p = scriptedExtractor([
			{ label: "x", content: "Plays chess on weekends", kind: "fact", span: "I play chess on weekends" },
			{ label: null, content: "Lives in Porto", kind: "fact", span: "I live in Porto", anchor: "chess" },
			{ label: null, content: "Owns a boat", kind: "fact", span: "my boat" },
		]);
		const call = {
			name: "extract",
			user: `Messages: ${JSON.stringify([
				{ id: "m1", text: "Hi" },
				{ id: "m2", text: "I play chess on weekends." },
			])}`,
		} as LlmCall<unknown>;
		const reply = await p.ask(call, new AbortController().signal);
		expect(reply.value).toEqual({
			items: [
				{
					content: "Plays chess on weekends",
					kind: "fact",
					span: "I play chess on weekends",
					prompt_id: "m2",
					attribute: null,
					entity: null,
				},
				{
					content: "Lives in Porto",
					kind: "fact",
					span: "I live in Porto",
					prompt_id: "m2",
					attribute: null,
					entity: null,
				},
			],
		});
		expect(p.calls).toEqual({ extract: 1 });
	});
});

describe("suite I run", () => {
	it("re-imports every fixture without changing the content hash, and makes only extract calls", async () => {
		const r = await runSuiteI(fakeEmbedder);
		expect(r.gate.reimport).toEqual({ fixtures: 17, unchanged: 17, pass: true });
		for (const row of r.reimport) expect(row.second).toMatchObject({ accepted: 0, already: row.items, status: "done" });
		for (const e of r.extraction.per_source) expect(Object.keys(e.llm_calls)).toEqual(["extract"]);
		// The span check drops, in every source, a scripted item whose span is in none of the call's messages or whose fact they do not support.
		const dropped = (c: Record<string, number>): number =>
			(c["extract.unsupported_span"] ?? 0) + (c["extract.low_support"] ?? 0);
		expect(r.extraction.per_source.filter((e) => dropped(e.counts) === 0).map((e) => e.source_type)).toEqual([]);
		expect(r.extraction.recall.n).toBe(35);
		expect(r.gate.false_merges.n).toBe(22);
	}, 60_000);
});
