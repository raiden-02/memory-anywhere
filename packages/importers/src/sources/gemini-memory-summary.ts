// `gemini-memory-summary`: the memory summary Gemini writes about the owner, copied from its page.
// Headings carry an emoji (dropped from the section hint); each section starts with a one-line
// description, then paragraphs. Sections go to the extractor (summary.ts).

import { importSummary, type SummaryShape } from "../summary.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export const GEMINI_SUMMARY_SHAPE: SummaryShape = {
	chrome: { exact: ["Memory summary", "Close dialog", "Close", "Share", "Copy"], prefixes: ["Updated "] },
	stopAt: [],
};

export function geminiMemorySummary(files: readonly SourceFile[]): ImportResult {
	return importSummary("gemini-memory-summary", files, GEMINI_SUMMARY_SHAPE);
}
