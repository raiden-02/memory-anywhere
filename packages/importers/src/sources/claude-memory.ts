// `claude-memory`: Claude's memory, copied from Settings or printed by Claude (importers.md §2).
// Two shapes arrive, and both give one item per line or bullet:
//
//   a plain list                    the "memory topics" page, one block per topic
//   - Prefers TypeScript            ## Cooking                      ← topic: the section hint
//   - [stated] Lives in Lisbon      Project / Orrery                ← optional; the project label, skipped
//                                   Last updated / Nov 9, 2026      ← the items' date
//                                   Summary / <one line>            ← Claude's description of the topic, skipped
//                                   Details                         ← the facts follow, one per line
//                                   Is vegetarian
//                                   Pixel                           ← a short line over longer ones: a sub-heading
//                                   Alex's dog, a beagle
//

import { Collector, isBullet, parseMonthDayYear, stripBullet } from "../common.ts";
import { readable } from "../lists.ts";
import type { ImportResult, SourceFile } from "../types.ts";

const HEADING = /^#{1,6}\s+(.+)$/u;
const SUB_HEADING_MAX = 30;

const isLabel = (line: string, label: string): boolean => line.toLowerCase() === label.toLowerCase();

/** A short line with no sentence punctuation, sitting over a longer line: a sub-heading inside Details. */
function isSubHeading(line: string, next: string | undefined): boolean {
	if (next === undefined || HEADING.test(next) || isBullet(line)) return false;
	return (
		line.length <= SUB_HEADING_MAX &&
		line.split(/\s+/u).length <= 4 &&
		!/[.!?:;,)]$/u.test(line) &&
		next.length > line.length
	);
}

export function claudeMemory(files: readonly SourceFile[]): ImportResult {
	const c = new Collector("claude-memory");
	for (const { text } of readable(c, files)) {
		const lines = text
			.split(/\r?\n/u)
			.map((l) => l.trim())
			.filter((l) => l !== "");
		let topic: string | undefined;
		let sub: string | undefined;
		let date: string | undefined;
		let state: "items" | "summary" | "details" = "items";
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const next = lines[i + 1];
			c.count("lines_read");
			const heading = HEADING.exec(line);
			if (heading) {
				topic = heading[1];
				sub = date = undefined;
				state = "items";
				c.count("topics");
				continue;
			}
			if (isLabel(line, "Project") && HEADING.test(lines[i - 1] ?? "") && next !== undefined) {
				c.count("lines_read");
				c.count("skipped_chrome", 2);
				i++;
				continue;
			}
			if (isLabel(line, "Last updated")) {
				const d = next === undefined ? undefined : parseMonthDayYear(next);
				if (d) {
					date = d;
					c.count("lines_read");
					i++;
				}
				c.count("skipped_chrome", d ? 2 : 1);
				continue;
			}
			if (isLabel(line, "Summary") || isLabel(line, "Details")) {
				state = isLabel(line, "Summary") ? "summary" : "details";
				c.count("skipped_chrome");
				continue;
			}
			if (!/[\p{L}\p{N}]/u.test(line)) {
				c.count("skipped_chrome"); // the page's icon glyphs
				continue;
			}
			if (state === "summary") {
				c.count("skipped_topic_summary");
				continue;
			}
			if (state === "details" && isSubHeading(line, next)) {
				sub = line;
				c.count("sub_headings");
				continue;
			}
			const hint = topic && sub ? `${topic} / ${sub}` : topic;
			c.atomic(stripBullet(line), { section_hint: hint, date });
		}
	}
	return c.result();
}
