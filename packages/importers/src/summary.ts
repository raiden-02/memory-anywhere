// The vendors' prose memory summaries (chatgpt-memory-summary, gemini-memory-summary): a few
// headed sections of paragraphs the vendor wrote about the owner. They are not a list of facts, so
// each section goes to the server's extractor:
//
//   Memory summary            ← dialog header, dropped
//   Updated just now          ← dialog header, dropped
//   Work and tools            ← heading: the section hint
//
//   Alex is a backend …       ← paragraphs: the item's messages (≤ 20 per item, each ≤ 4,000 chars)
//   Dive Deeper               ← the dialog's suggestions start here: dropped to the end
//   Close dialog              ← button, dropped

import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import { Collector, MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_ITEM, packSentences, sectionHint } from "./common.ts";
import { isChrome, readable, type Chrome } from "./lists.ts";
import type { ImportResult, SourceFile, SourceType } from "./types.ts";

export interface SummaryShape {
	/** Lines that are never content (dialog title, "Updated …", buttons). */
	readonly chrome: Chrome;
	/** A line from which everything to the end is dropped (the vendor's follow-up suggestions). */
	readonly stopAt: readonly string[];
}

export interface Section {
	readonly heading: string | undefined;
	readonly paragraphs: readonly string[];
}

const HEADING_MAX = 80;

/** A heading: a short line with no sentence-ending or clause punctuation. */
export function isSummaryHeading(line: string): boolean {
	return line.length <= HEADING_MAX && !/[.!?:;,)"”]$/u.test(line);
}

/** The text's sections, with the dialog's chrome and the trailing suggestions removed; counts what it dropped. */
export function summarySections(c: Collector, text: string, shape: SummaryShape): Section[] {
	const sections: { heading: string | undefined; paragraphs: string[] }[] = [];
	let current: { heading: string | undefined; paragraphs: string[] } | undefined;
	const lines = text
		.split(/\r?\n/u)
		.map((l) => l.trim())
		.filter((l) => l !== "");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		c.count("lines_read");
		if (shape.stopAt.some((s) => s.toLowerCase() === line.toLowerCase())) {
			c.count("skipped_chrome", lines.length - i);
			c.count("lines_read", lines.length - i - 1);
			break;
		}
		if (isChrome(line, shape.chrome)) {
			c.count("skipped_chrome");
			continue;
		}
		if (isSummaryHeading(line)) {
			current = { heading: line, paragraphs: [] };
			sections.push(current);
			continue;
		}
		if (!current) {
			current = { heading: undefined, paragraphs: [] };
			sections.push(current);
		}
		current.paragraphs.push(line);
	}
	const kept = sections.filter((s) => s.paragraphs.length > 0);
	c.count("sections", kept.length);
	c.count("skipped_empty_sections", sections.length - kept.length);
	return kept;
}

/** One extract item per section (more when a section has over 20 paragraphs). */
export function importSummary(sourceType: SourceType, files: readonly SourceFile[], shape: SummaryShape): ImportResult {
	const c = new Collector(sourceType);
	for (const { file, text } of readable(c, files)) {
		for (const section of summarySections(c, text, shape)) {
			const messages: string[] = [];
			for (const p of section.paragraphs) {
				c.count("paragraphs");
				const clean = c.redacted(p);
				if (clean !== undefined) messages.push(...packSentences(clean, MAX_MESSAGE_CHARS));
			}
			const id = contentNormHash([section.heading ?? "", ...section.paragraphs].join("\n"));
			const hint = section.heading === undefined ? undefined : sectionHint(section.heading);
			for (let at = 0, ordinal = 0; at < messages.length; at += MAX_MESSAGES_PER_ITEM, ordinal++) {
				c.extract(id, ordinal, messages.slice(at, at + MAX_MESSAGES_PER_ITEM), {
					section_hint: hint,
					group_id: file.name,
				});
			}
		}
	}
	return c.result();
}
