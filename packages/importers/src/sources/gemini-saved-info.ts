// `gemini-saved-info`: Gemini's Saved info page, copied (importers.md §2). One item per line; the
// page's own labels are dropped.

import { Collector } from "../common.ts";
import { importList, type Chrome } from "../lists.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export const GEMINI_SAVED_INFO_CHROME: Chrome = {
	exact: ["Saved info", "Add", "Edit", "Delete", "Delete all", "Close dialog", "Learn more", "Turn off", "Turn on"],
	prefixes: [
		"Info you asked Gemini to save",
		"Share info about your life and preferences",
		"Gemini Apps use this info",
	],
};

export function geminiSavedInfo(files: readonly SourceFile[]): ImportResult {
	const c = new Collector("gemini-saved-info");
	importList(c, files, GEMINI_SAVED_INFO_CHROME);
	return c.result();
}
