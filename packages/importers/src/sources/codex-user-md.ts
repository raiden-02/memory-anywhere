// `codex-user-md`: the owner's own Codex instructions, ~/.codex/AGENTS.md, outside the block
// memory-anywhere manages there (importers.md §2, rule 3). As claude-user-md.

import { importMarkdown } from "../markdown.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export function codexUserMd(files: readonly SourceFile[]): ImportResult {
	return importMarkdown("codex-user-md", files, { paragraphs: "sentences", dateFromMtime: false });
}
