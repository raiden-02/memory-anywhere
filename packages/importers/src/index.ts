// @memory-anywhere/importers (importers.md): turns what the owner already has on this PC (vendor
// memory lists and summaries, instruction files, coding-tool memories, chat exports) into import
// items for `POST /v1/admin/import`. Nothing here talks to the store; the client does.

import { chatgptHistory } from "./sources/chatgpt-history.ts";
import { chatgptMemorySummary } from "./sources/chatgpt-memory-summary.ts";
import { chatgptMemory } from "./sources/chatgpt-memory.ts";
import { claudeCodeAutoMemory } from "./sources/claude-code-auto-memory.ts";
import { claudeHistory } from "./sources/claude-history.ts";
import { claudeMemory } from "./sources/claude-memory.ts";
import { claudeUserMd } from "./sources/claude-user-md.ts";
import { codexMemories } from "./sources/codex-memories.ts";
import { codexUserMd } from "./sources/codex-user-md.ts";
import { geminiHistory } from "./sources/gemini-history.ts";
import { geminiMemorySummary } from "./sources/gemini-memory-summary.ts";
import { geminiSavedInfo } from "./sources/gemini-saved-info.ts";
import { paste } from "./sources/paste.ts";
import type { ImportOptions, ImportResult, SourceFile, SourceType } from "./types.ts";

export type {
	Counts,
	EstimateInputs,
	ImportItemT,
	ImportOptions,
	ImportResult,
	SourceFile,
	SourceType,
} from "./types.ts";
export { EXTRACTOR_VERSION, itemKey, MAX_ATOMIC_CHARS, MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_ITEM } from "./common.ts";
export { DEFAULT_MIN_USER_TURNS, parseDateFlag } from "./history.ts";
export {
	FILE_SOURCES,
	guardPath,
	HISTORY_SOURCES,
	loadInput,
	PathGuardError,
	userDirs,
	type LoadedInput,
	type UserDirs,
} from "./files.ts";

const IMPORTERS: Record<SourceType, (files: readonly SourceFile[], o: ImportOptions) => ImportResult> = {
	"claude-memory": (f) => claudeMemory(f),
	"chatgpt-memory": (f) => chatgptMemory(f),
	"gemini-saved-info": (f) => geminiSavedInfo(f),
	paste: (f, o) => paste(f, o.vendor),
	"claude-user-md": (f) => claudeUserMd(f),
	"codex-user-md": (f) => codexUserMd(f),
	"claude-code-auto-memory": (f) => claudeCodeAutoMemory(f),
	"codex-memories": (f) => codexMemories(f),
	"chatgpt-history": chatgptHistory,
	"claude-history": claudeHistory,
	"gemini-history": geminiHistory,
	"chatgpt-memory-summary": (f) => chatgptMemorySummary(f),
	"gemini-memory-summary": (f) => geminiMemorySummary(f),
};

export const SOURCE_TYPES = Object.keys(IMPORTERS) as SourceType[];

export function isSourceType(s: string): s is SourceType {
	return Object.hasOwn(IMPORTERS, s);
}

/** Parses, skips, redacts, splits and keys one source's files (importers.md §1 rules 3–5). */
export function runImporter(source: SourceType, files: readonly SourceFile[], o: ImportOptions = {}): ImportResult {
	return IMPORTERS[source](files, o);
}
