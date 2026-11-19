// `codex-memories`: Codex's memories, ~/.codex/memories/*.md, when the feature is on (importers.md
// §2). The format is undocumented, so it is read as plain markdown: one item per bullet or
// paragraph, dated by the file's last write. Model-written: observations on the server.

import { importMarkdown } from "../markdown.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export function codexMemories(files: readonly SourceFile[]): ImportResult {
	return importMarkdown("codex-memories", files, { paragraphs: "long", dateFromMtime: true });
}
