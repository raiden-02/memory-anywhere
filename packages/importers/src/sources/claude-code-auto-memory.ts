// `claude-code-auto-memory`: the memories Claude Code writes itself, ~/.claude/projects/*/memory/*.md
// (importers.md §2). Model-written, so the server keeps them as observations that need recurrence.
// Each file is one memory with front matter; its MEMORY.md is only an index of the others and is
// not read (files.ts). One item per bullet or paragraph, dated by the file's last write.

import { importMarkdown } from "../markdown.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export function claudeCodeAutoMemory(files: readonly SourceFile[]): ImportResult {
	return importMarkdown("claude-code-auto-memory", files, { paragraphs: "long", dateFromMtime: true });
}
