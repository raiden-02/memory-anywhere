// `paste --vendor <name>`: any other app's memory (Grok, Cursor user rules…) pasted as a list
// (importers.md §2). One item per line; the vendor becomes the items' group.

import { Collector } from "../common.ts";
import { importList, NO_CHROME } from "../lists.ts";
import type { ImportResult, SourceFile } from "../types.ts";

/** A vendor name as a group label: lowercase letters, digits and dashes. */
export function vendorLabel(vendor: string | undefined): string {
	const v = (vendor ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "");
	if (v === "") throw new Error("--source paste needs --vendor <name> (the app the list came from)");
	return v.slice(0, 40);
}

export function paste(files: readonly SourceFile[], vendor: string | undefined): ImportResult {
	const group = `paste:${vendorLabel(vendor)}`;
	const c = new Collector("paste");
	importList(c, files, NO_CHROME, () => ({ group_id: group }));
	return c.result();
}
