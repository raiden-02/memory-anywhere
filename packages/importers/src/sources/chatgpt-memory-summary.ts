// `chatgpt-memory-summary`: the "Memory summary" ChatGPT writes about the owner, copied from its
// dialog. Sections go to the extractor (summary.ts); the "Dive Deeper" suggestions are dropped.

import { importSummary, type SummaryShape } from "../summary.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export const CHATGPT_SUMMARY_SHAPE: SummaryShape = {
	chrome: { exact: ["Memory summary", "Close dialog", "Close", "Share", "Copy"], prefixes: ["Updated "] },
	stopAt: ["Dive Deeper", "Dive deeper"],
};

export function chatgptMemorySummary(files: readonly SourceFile[]): ImportResult {
	return importSummary("chatgpt-memory-summary", files, CHATGPT_SUMMARY_SHAPE);
}
