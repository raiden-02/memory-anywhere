// What every importer takes and returns (importers.md). An importer reads text the owner already
// has on this PC and turns it into upload items; it never talks to the store.
//
//   files on disk ──files.ts──► SourceFile[] ──sources/<type>.ts──► ImportResult
//                  (path guard,               (parse, skip markers,   { items, counts, estimate }
//                   ZIP, hash)                 redact, split, key)

import type { z } from "zod";
import type { ImportItem, ImportSourceType } from "@memory-anywhere/contracts/schemas/v1";

export type SourceType = z.infer<typeof ImportSourceType>;
export type ImportItemT = z.infer<typeof ImportItem>;

/** One input file, already read. `name` is a label for the report and `group_id`, never an absolute path. */
export interface SourceFile {
	readonly name: string;
	readonly text: string;
	/** When the file was last written; model-written memories use it as the item's date. */
	readonly mtime?: Date | undefined;
}

/** Options that only some sources read. */
export interface ImportOptions {
	/** `paste` only: the app the list came from (Grok, Cursor…); becomes the items' `group_id`. */
	readonly vendor?: string | undefined;
	/** History only: keep user messages said on or after this instant. */
	readonly since?: Date | undefined;
	/** History only: keep user messages said on or before this instant. */
	readonly until?: Date | undefined;
	/** History only: drop conversations with fewer user turns than this (default 2). */
	readonly conversationMinUserTurns?: number | undefined;
}

/**
 * Report counts (importers.md §5): how many things were read, kept and skipped, by reason. Keys are
 * stable snake_case names; values are counts only, never content.
 */
export type Counts = Record<string, number>;

/** The counts `POST /v1/import/estimate` takes (write-path.md §10.5 step 1). */
export interface EstimateInputs {
	/** User-authored messages (history) or prose paragraphs (summaries) the extractor will read; 0 for atomic sources. */
	readonly turns: number;
	/** Characters the server will read: extractor input, or atomic content. */
	readonly chars: number;
	readonly item_count: number;
}

export interface ImportResult {
	readonly source_type: SourceType;
	readonly items: readonly ImportItemT[];
	readonly counts: Counts;
	readonly estimate: EstimateInputs;
}
