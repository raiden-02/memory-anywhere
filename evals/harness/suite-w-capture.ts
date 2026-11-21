// Suite W capture items (write-path.md §10.2, §12): extracted items, each with the coding-tool
// prompt it came from, labelled by the author as faithful or not. Each goes through the server's
// own span check, so the numbers are the product's:
//
//   faithful item dropped   → the check lost a real fact      (gate: ≤ 5% at capture_support_min)
//   unfaithful item dropped → the check caught an invented one (reported)
//
// A sweep over support thresholds shows the trade-off the calibration chose from. No model runs:
// the items stand in for the extractor's answers, so the suite needs no key.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import { spanCheck } from "../../packages/server/src/write/imports.ts";
import { wilson } from "./stats.ts";

export const CAPTURE_ITEMS_FILE = new URL("../datasets/w/capture.jsonl", import.meta.url);

const CaptureItem = z.strictObject({
	id: z.string().regex(/^wc\d{3}$/u),
	prompt: z.string().min(1),
	item: z.strictObject({ content: z.string().min(1), span: z.string().min(1) }),
	correct: z.boolean(),
	note: z.string(),
});
export type CaptureItemT = z.infer<typeof CaptureItem>;

export function loadCaptureItems(file: URL = CAPTURE_ITEMS_FILE): CaptureItemT[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => CaptureItem.parse(JSON.parse(l)));
}

/** Whether the span check drops `c` at support threshold `min`. */
const dropped = (c: CaptureItemT, min: number): boolean =>
	spanCheck({ ...c.item, kind: "fact", prompt_id: "m1" }, [c.prompt], min) !== undefined;

export const DROP_MAX = 0.05;

export interface CaptureItemsResult {
	readonly n: number;
	readonly labels: "author-labelled";
	readonly capture_support_min: number;
	readonly gate: {
		readonly k: number;
		readonly n: number;
		readonly rate: number;
		readonly ci95: [number, number];
		readonly max: number;
		readonly pass: boolean;
	};
	readonly caught: { readonly k: number; readonly n: number; readonly ci95: [number, number] };
	readonly sweep: readonly { readonly min: number; readonly correct_dropped: number; readonly wrong_caught: number }[];
	readonly dropped_correct: readonly string[];
	readonly missed_wrong: readonly string[];
}

export function runCaptureItems(
	items: readonly CaptureItemT[],
	supportMin = defaultConfig().write.capture_support_min,
): CaptureItemsResult {
	const correct = items.filter((c) => c.correct);
	const wrong = items.filter((c) => !c.correct);
	const lost = correct.filter((c) => dropped(c, supportMin));
	const caught = wrong.filter((c) => dropped(c, supportMin));
	const rate = correct.length === 0 ? 0 : lost.length / correct.length;
	return {
		n: items.length,
		labels: "author-labelled",
		capture_support_min: supportMin,
		gate: {
			k: lost.length,
			n: correct.length,
			rate,
			ci95: wilson(lost.length, correct.length).ci95,
			max: DROP_MAX,
			pass: correct.length > 0 && rate <= DROP_MAX,
		},
		caught: { k: caught.length, n: wrong.length, ci95: wilson(caught.length, wrong.length).ci95 },
		sweep: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((min) => ({
			min,
			correct_dropped: correct.filter((c) => dropped(c, min)).length,
			wrong_caught: wrong.filter((c) => dropped(c, min)).length,
		})),
		dropped_correct: lost.map((c) => c.id),
		missed_wrong: wrong.filter((c) => !dropped(c, supportMin)).map((c) => c.id),
	};
}
