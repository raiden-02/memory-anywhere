// Import test helpers: synthetic upload items (persona-free facts), a batch started without the
// step-up page, a worker drain, and a free loopback port for the HTTP tests.

import { createHash } from "node:crypto";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { z } from "zod";
import type { ImportItem, ImportSourceType } from "@memory-anywhere/contracts/schemas/v1";
import type { App } from "../../src/app.ts";
import { StepUps } from "../../src/auth/stepup.ts";
import { JobWorker } from "../../src/jobs/worker.ts";
import { createBatch } from "../../src/write/imports.ts";

export type Item = z.infer<typeof ImportItem>;
export type SourceType = z.infer<typeof ImportSourceType>;

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The SHA-256 of the synthetic export file every test imports unless it names another. */
export const FILE = sha("synthetic export file");

/** A list line (atomic sources), keyed by its text. */
export const atomic = (content: string, o: Partial<Item> = {}): Item => ({
	key: sha(`atomic|${content}`),
	source_item_id: sha(content),
	ordinal: 0,
	mode: "atomic",
	content,
	...o,
});

/** Messages of one conversation or summary section, for the extractor (history and summary sources). */
export const extract = (messages: string[], o: Partial<Item> = {}): Item => ({
	key: sha(`extract|${messages.join("|")}|${o.group_id ?? ""}`),
	source_item_id: o.group_id ?? "conv-1",
	ordinal: 0,
	mode: "extract",
	messages,
	...o,
});

/** Starts a batch as an approved step-up would (write-path.md §10.5 step 2), with a $1 budget unless given. */
export function begin(app: App, source: SourceType, itemCount: number, file = FILE, estimateUsd = 1): string {
	const r = createBatch(app.ctx, {
		source_type: source,
		file_sha256: file,
		item_count: itemCount,
		estimate_usd: estimateUsd,
	});
	if (!r.ok) throw new Error(r.message);
	return r.batchId;
}

/** The step-ups of an App, pricing imports with its own estimate as the server does. */
export const stepUpsFor = (app: App): StepUps =>
	new StepUps(app.ctx, app.alerts, "https://admin.memory.example.com", (r) => app.importEstimate(r).estimate_usd);

/** Runs queued jobs until none is due. */
export async function drain(app: App): Promise<void> {
	const worker = new JobWorker(app);
	while (await worker.tick()) {
		/* one turn at a time */
	}
}

export async function freePort(): Promise<number> {
	const probe = createNetServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}
