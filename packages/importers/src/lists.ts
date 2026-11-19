// Vendor memory lists pasted from a settings page (importers.md §2: claude-memory, chatgpt-memory,
// gemini-saved-info, paste). One item per non-empty line or bullet. A copied settings dialog also
// carries its own words (a title, an explanation, button labels): `Chrome` names them so they are
// dropped, counted as `skipped_chrome`, instead of becoming "memories".

import { Collector, isGeneratedFile, stripBullet, stripManagedBlocks, type ItemMeta } from "./common.ts";
import type { SourceFile } from "./types.ts";

/** The words of a vendor's memory dialog, which are never the owner's memories. */
export interface Chrome {
	/** Whole lines that are UI text (compared case-insensitively). */
	readonly exact: readonly string[];
	/** Line starts that are UI text (an explanation paragraph, cut wherever the copy ends). */
	readonly prefixes: readonly string[];
	/**
	 * The dialog's last header line (e.g. the search box label): when it appears among the first
	 * lines, everything up to it is header and is dropped.
	 */
	readonly headerEnd?: string | undefined;
}

export const NO_CHROME: Chrome = { exact: [], prefixes: [] };

/** How many leading lines may hold a dialog header. */
const HEADER_WINDOW = 15;

export function isChrome(line: string, chrome: Chrome): boolean {
	const l = line.trim().toLowerCase();
	return chrome.exact.some((e) => e.toLowerCase() === l) || chrome.prefixes.some((p) => l.startsWith(p.toLowerCase()));
}

/** The lines of `text` after the dialog header (when the header's last line is found near the top). */
export function afterHeader(lines: readonly string[], chrome: Chrome): { lines: readonly string[]; header: number } {
	if (!chrome.headerEnd) return { lines, header: 0 };
	const end = chrome.headerEnd.toLowerCase();
	const nonEmpty = lines
		.map((l, i) => [l.trim(), i] as const)
		.filter(([l]) => l !== "")
		.slice(0, HEADER_WINDOW);
	const hit = nonEmpty.find(([l]) => l.toLowerCase() === end);
	if (!hit) return { lines, header: 0 };
	return { lines: lines.slice(hit[1] + 1), header: nonEmpty.filter(([, i]) => i <= hit[1]).length };
}

/**
 * The files an importer may read, after rule 3: a file marked as memory-anywhere's own output is
 * skipped whole, and managed blocks are cut out of the rest.
 */
export function readable(c: Collector, files: readonly SourceFile[]): { file: SourceFile; text: string }[] {
	const out: { file: SourceFile; text: string }[] = [];
	for (const file of files) {
		c.count("files_read");
		if (isGeneratedFile(file.text)) {
			c.count("skipped_marker_files");
			continue;
		}
		const { text, blocks } = stripManagedBlocks(file.text);
		c.count("skipped_marker_blocks", blocks);
		out.push({ file, text });
	}
	return out;
}

/** One atomic item per non-empty line; UI chrome dropped. */
export function importList(
	c: Collector,
	files: readonly SourceFile[],
	chrome: Chrome,
	meta: (file: SourceFile) => ItemMeta = () => ({}),
): void {
	for (const { file, text } of readable(c, files)) {
		const { lines, header } = afterHeader(text.split(/\r?\n/u), chrome);
		c.count("lines_read", header);
		c.count("skipped_chrome", header);
		for (const line of lines) {
			if (line.trim() === "") continue;
			c.count("lines_read");
			if (isChrome(line, chrome)) {
				c.count("skipped_chrome");
				continue;
			}
			c.atomic(stripBullet(line), meta(file));
		}
	}
}
