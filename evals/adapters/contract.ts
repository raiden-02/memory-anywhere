// The adapter contract of evals.md §8.1: how the harness drives a memory system it does not own.
// An adapter maps these six calls onto the system's own API (mem0's Python API, an MCP server's
// tools), so every suite can score any system the same way. What a system cannot do it declares in
// capabilities(), and suites report the metrics that need it as n/a instead of scoring them.

export interface SaveFact {
	readonly content: string;
	readonly kind?: string;
	readonly entity?: string;
	readonly attribute?: string;
	readonly valid_from?: string;
	readonly user_words?: string;
	/** Id of the memory this fact replaces; honoured only when capabilities().supersede. */
	readonly supersedes?: string;
}

export interface SaveCtx {
	readonly client: string;
	readonly session: string;
	/** ISO time the fact was said. */
	readonly at: string;
}

export interface RecallCtx {
	readonly client: string;
	/** Point in time to recall at; honoured only when capabilities().bitemporal. */
	readonly as_of?: string;
}

export interface Saved {
	/** The stored memory's id, when the save stored one. */
	readonly id?: string;
	/** The system's own word for what happened ("added", "duplicate", "updated", ...). */
	readonly outcome: string;
}

export interface Recalled {
	readonly id: string;
	readonly content: string;
	readonly score?: number;
}

export interface Capabilities {
	/** A save can replace a named memory (save({supersedes})), not only add next to it. */
	readonly supersede: boolean;
	/** Recall can be asked about a past point in time (valid time and record time). */
	readonly bitemporal: boolean;
	/** Saves report a policy outcome (active, observation, review, reject) that suite W can score. */
	readonly outcomes: boolean;
}

export interface MemoryAdapter {
	readonly name: string;
	/** Empty the store. */
	reset(): Promise<void>;
	save(fact: SaveFact, ctx: SaveCtx): Promise<Saved>;
	/** At most k memories, best first. */
	recall(query: string, k: number, ctx: RecallCtx): Promise<Recalled[]>;
	forget(id: string): Promise<void>;
	capabilities(): Capabilities;
}

/** An adapter backed by a process or container: it describes its pinned versions and must be closed. */
export interface ExternalAdapter extends MemoryAdapter {
	/** Everything a report needs to name the system exactly (versions, image, models). */
	describe(): SystemInfo;
	close(): Promise<void>;
}

export type SystemInfo = Readonly<Record<string, unknown>>;

/** Suites a system can be scored on, given what it declares. */
export function supportedSuites(c: Capabilities): { R: true; W: boolean; I: boolean } {
	// R needs only save and recall. W classifies each save into an operation, so it needs outcomes.
	// I scores the importers' decisions (duplicate, merge, new), which are W's outcomes too.
	return { R: true, W: c.outcomes, I: c.outcomes };
}
