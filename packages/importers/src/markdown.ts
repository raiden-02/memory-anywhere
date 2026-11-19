// Markdown memory files on this PC (importers.md §2): the owner's instruction files
// (claude-user-md, codex-user-md) and the coding tools' model-written memories
// (claude-code-auto-memory, codex-memories). Each file becomes blocks:
//
//   ---                         front matter: skipped
//   name: …
//   ---
//   # Preferences               heading: the section hint of what follows
//   - Prefers short answers     bullet (with its indented continuation lines): one block
//   Alex works in Lisbon.       consecutive plain lines: one paragraph block
//   It is sunny.
//   ```sh … ```                 code: skipped
//   | a | b |                   table: skipped
//
// Bullets become one item each; a paragraph is split into sentences (owner-written files) or kept
// whole (model-written files, whose paragraphs are one memory each).

import { Collector, isBullet, sectionHint, stripBullet, type AtomicSplit } from "./common.ts";
import { readable } from "./lists.ts";
import type { ImportResult, SourceFile, SourceType } from "./types.ts";

export interface MdBlock {
	readonly kind: "bullet" | "paragraph";
	readonly text: string;
	readonly heading: string | undefined;
}

/** Inline markdown reduced to its text: emphasis marks, inline code ticks and link targets removed. */
export function plainInline(text: string): string {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/(\*\*|__)(.+?)\1/gu, "$2")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/\s+/gu, " ")
		.trim();
}

/** The blocks of a markdown file, with how many code blocks, tables and HTML comments were skipped. */
export function markdownBlocks(text: string): {
	blocks: MdBlock[];
	skipped: { code: number; table: number; comment: number };
} {
	const lines = text.split(/\r?\n/u);
	const blocks: MdBlock[] = [];
	const skipped = { code: 0, table: 0, comment: 0 };
	let heading: string | undefined;
	let open: { kind: MdBlock["kind"]; parts: string[]; indent: number } | undefined;
	const close = (): void => {
		if (open) blocks.push({ kind: open.kind, text: plainInline(open.parts.join(" ")), heading });
		open = undefined;
	};
	let i = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
		if (end > 0) i = end + 1;
	}
	for (; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const t = line.trim();
		if (/^(```|~~~)/u.test(t)) {
			close();
			const fence = t.slice(0, 3);
			while (i + 1 < lines.length && !(lines[i + 1] ?? "").trim().startsWith(fence)) i++;
			i++;
			skipped.code++;
			continue;
		}
		if (t.startsWith("<!--")) {
			close();
			while (i < lines.length && !(lines[i] ?? "").includes("-->")) i++;
			skipped.comment++;
			continue;
		}
		if (t === "") {
			close();
			continue;
		}
		const h = /^#{1,6}\s+(.+?)\s*#*$/u.exec(t);
		if (h) {
			close();
			heading = plainInline(h[1] ?? "");
			continue;
		}
		if (t.startsWith("|")) {
			close();
			if (!(lines[i - 1] ?? "").trim().startsWith("|")) skipped.table++;
			continue;
		}
		if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(t)) {
			close();
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (isBullet(line)) {
			close();
			open = { kind: "bullet", parts: [stripBullet(t)], indent };
			continue;
		}
		// A plain line continues the open bullet when indented under it, or the open paragraph.
		if (open && (open.kind === "paragraph" || indent > open.indent)) {
			open.parts.push(t.replace(/^>\s?/u, ""));
			continue;
		}
		close();
		open = { kind: "paragraph", parts: [t.replace(/^>\s?/u, "")], indent };
	}
	close();
	return { blocks, skipped };
}

/** A short line that only introduces what follows ("Two rules:"); it states nothing by itself. */
export function isLeadIn(text: string): boolean {
	return text.endsWith(":") && text.split(/\s+/u).length <= 6;
}

export interface MarkdownImport {
	/** How a paragraph becomes items (bullets are always one item, split by sentence only when too long). */
	readonly paragraphs: AtomicSplit;
	/** Model-written memories are dated by the file's last write. */
	readonly dateFromMtime: boolean;
}

export function importMarkdown(
	sourceType: SourceType,
	files: readonly SourceFile[],
	how: MarkdownImport,
): ImportResult {
	const c = new Collector(sourceType);
	for (const { file, text } of readable(c, files)) {
		const { blocks, skipped } = markdownBlocks(text);
		c.count("skipped_code_blocks", skipped.code);
		c.count("skipped_tables", skipped.table);
		c.count("skipped_comments", skipped.comment);
		const date = how.dateFromMtime && file.mtime ? file.mtime.toISOString().slice(0, 10) : undefined;
		for (const b of blocks) {
			c.count(b.kind === "bullet" ? "bullets_read" : "paragraphs_read");
			if (isLeadIn(b.text)) {
				c.count("skipped_lead_ins");
				continue;
			}
			const meta = {
				section_hint: b.heading === undefined ? undefined : sectionHint(b.heading),
				group_id: file.name,
				date,
			};
			c.atomic(b.text, meta, b.kind === "bullet" ? "long" : how.paragraphs);
		}
	}
	return c.result();
}
