// `claude-user-md`: the owner's own Claude Code instructions, ~/.claude/CLAUDE.md and
// ~/.claude/rules/*.md (importers.md §2). Owner-written: one item per bullet or sentence, headings
// as section hints. Never a repository's CLAUDE.md (rule 2; files.ts guards the paths).

import { importMarkdown } from "../markdown.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export function claudeUserMd(files: readonly SourceFile[]): ImportResult {
	return importMarkdown("claude-user-md", files, { paragraphs: "sentences", dateFromMtime: false });
}
