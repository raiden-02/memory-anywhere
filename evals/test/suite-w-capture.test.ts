// Suite W capture items (write-path.md §12): the dataset is well formed and the span check at the
// configured capture_support_min drops at most 5% of faithful items.

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import { DROP_MAX, loadCaptureItems, runCaptureItems } from "../harness/suite-w-capture.ts";

const items = loadCaptureItems();

describe("suite W capture items", () => {
	it("has unique ids, faithful items whose span is the prompt's own words, and both labels", () => {
		expect(new Set(items.map((c) => c.id)).size).toBe(items.length);
		for (const c of items.filter((x) => x.correct)) expect(c.prompt).toContain(c.item.span);
		expect(items.filter((c) => c.correct).length).toBeGreaterThanOrEqual(40);
		expect(items.filter((c) => !c.correct).length).toBeGreaterThanOrEqual(20);
	});

	it("passes at the configured threshold, and reports what it catches", () => {
		const r = runCaptureItems(items);
		expect(r.capture_support_min).toBe(defaultConfig().write.capture_support_min);
		expect(r.gate.rate).toBeLessThanOrEqual(DROP_MAX);
		expect(r.gate.pass).toBe(true);
		expect(r.caught.n).toBe(items.filter((c) => !c.correct).length);
		expect(r.sweep.map((s) => s.min)).toContain(r.capture_support_min);
	});

	it("fails the gate when the threshold drops faithful items", () => {
		expect(runCaptureItems(items, 1.01).gate.pass).toBe(false);
	});
});
