// `chatgpt-memory`: ChatGPT's saved memories, copied from Settings > Personalization > Memory
// (importers.md §2). The copy is the dialog's text: a header (title, explanation, search box),
// then one memory per line, then the close button. One item per memory line.

import { Collector } from "../common.ts";
import { importList, type Chrome } from "../lists.ts";
import type { ImportResult, SourceFile } from "../types.ts";

export const CHATGPT_MEMORY_CHROME: Chrome = {
	exact: [
		"Saved memories",
		"Manage memories",
		"Search memories",
		"Revert to this experience",
		"Close dialog",
		"Close",
		"Delete",
		"Delete all",
		"Clear ChatGPT's memory",
		"Learn more",
		"Memory",
		"Memory updated",
		"Reference saved memories",
	],
	prefixes: [
		"Let ChatGPT personalize your experience",
		"This is a legacy version of memory",
		"ChatGPT's improved memory",
		"Memory is full",
		"Memory full",
	],
	headerEnd: "Search memories",
};

export function chatgptMemory(files: readonly SourceFile[]): ImportResult {
	const c = new Collector("chatgpt-memory");
	importList(c, files, CHATGPT_MEMORY_CHROME);
	return c.result();
}
