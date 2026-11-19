// `mema import` (importers.md, write-path.md §10.5). Everything is parsed and redacted on this PC;
// only counts leave it on a dry run, and only redacted items on a commit.
//
//   --dry-run   parse ─► report ─► POST /v1/import/estimate (counts only) ─► record {source, sha256, estimate}
//   --commit    parse ─► dry run of this sha256 in the last 24 h? (rule 7)
//                    ─► step-up `import` {source_type, file_sha256, item_count, chars, estimate_usd}
//                         (the server prices the import itself; the owner types its estimate in whole dollars,
//                          which becomes the batch's budget, and approves with a passkey; the approval creates the batch)
//                    ─► POST /v1/admin/import, ≤ 100 items and ≤ 1 MiB each, MA-Step-Up: the batch's 60-minute token
//                    ─► GET /v1/import/batches/<batch> until it is no longer running ─► report (counts only)
//   --resume <batch>   a fresh step-up for the same batch; items it already recorded come back as `already`
//
// In local mode the local token is the owner credential (as adminCall): the batch is opened (or
// reopened) with POST /v1/admin/import {ImportArgs} ──► {import_batch_id}, and uploads carry no step-up.

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { ensurePrivateDir, writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import type { Paths } from "@memory-anywhere/contracts/paths";
import type {
	ImportBatchStatus,
	ImportEstimateResponse,
	ImportUploadResponse,
} from "@memory-anywhere/contracts/schemas/v1";
import {
	DEFAULT_MIN_USER_TURNS,
	HISTORY_SOURCES,
	loadInput,
	parseDateFlag,
	runImporter,
	userDirs,
	type Counts,
	type ImportItemT,
	type ImportResult,
	type SourceType,
	type UserDirs,
} from "@memory-anywhere/importers";
import type { CommandDeps } from "./commands.ts";
import { approve } from "./stepup.ts";
import { StoreError } from "./store-client.ts";

type EstimateT = z.infer<typeof ImportEstimateResponse>;
type UploadT = z.infer<typeof ImportUploadResponse>;
type BatchStatusT = z.infer<typeof ImportBatchStatus>;

/** Upload limits per request (importers.md rule 8). */
export const MAX_UPLOAD_ITEMS = 100;
export const MAX_UPLOAD_BYTES = 1024 * 1024;
/** How long a dry run lets a commit of the same input go ahead (rule 7). */
export const DRY_RUN_VALID_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 2000;
const CALL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface ImportOptions {
	/** A file or folder; undefined reads a file source's default user-level location. */
	readonly target: string | undefined;
	readonly source: SourceType;
	readonly mode: "dry-run" | "commit";
	readonly vendor?: string | undefined;
	readonly resume?: string | undefined;
	readonly since?: string | undefined;
	readonly until?: string | undefined;
	readonly conversationMinUserTurns?: number | undefined;
}

// ---- rule 7: the dry-run record

/** One dry run, kept on this PC (never content: the source, the input's hash and the estimate). */
export interface DryRunRecord {
	readonly source_type: SourceType;
	readonly file_sha256: string;
	readonly at: string;
	readonly item_count: number;
	readonly estimate_usd: number;
}

export const dryRunFile = (paths: Paths): string => path.join(paths.dataDir, "import-dry-runs.json");

function readDryRuns(paths: Paths): DryRunRecord[] {
	try {
		const parsed = JSON.parse(readFileSync(dryRunFile(paths), "utf8")) as { runs?: unknown };
		return Array.isArray(parsed.runs) ? (parsed.runs as DryRunRecord[]) : [];
	} catch {
		return [];
	}
}

const fresh = (r: DryRunRecord, now: number): boolean => {
	const at = Date.parse(r.at);
	return Number.isFinite(at) && now - at <= DRY_RUN_VALID_MS && at <= now;
};

/** Records a dry run; runs older than 24 hours are dropped from the file. */
export function recordDryRun(paths: Paths, run: DryRunRecord, now: number): void {
	const runs = readDryRuns(paths).filter(
		(r) => fresh(r, now) && !(r.source_type === run.source_type && r.file_sha256 === run.file_sha256),
	);
	ensurePrivateDir(paths.dataDir);
	writeFileAtomic(dryRunFile(paths), `${JSON.stringify({ schema: 1, runs: [...runs, run] }, null, 2)}\n`, {
		private: true,
	});
}

/** The dry run of this input in the last 24 hours, if there is one. */
export function findDryRun(paths: Paths, source: SourceType, sha256: string, now: number): DryRunRecord | undefined {
	return readDryRuns(paths).find((r) => r.source_type === source && r.file_sha256 === sha256 && fresh(r, now));
}

// ---- rule 8: upload chunks

/** Splits items into upload bodies of at most 100 items and 1 MiB of JSON each, in order. */
export function chunkItems(
	batchId: string,
	items: readonly ImportItemT[],
	maxItems = MAX_UPLOAD_ITEMS,
	maxBytes = MAX_UPLOAD_BYTES,
): ImportItemT[][] {
	const overhead = Buffer.byteLength(JSON.stringify({ batch_id: batchId, items: [] }));
	const chunks: ImportItemT[][] = [];
	let cur: ImportItemT[] = [];
	let bytes = overhead;
	for (const item of items) {
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (overhead + size > maxBytes)
			throw new Error(`item ${item.key.slice(0, 12)} alone is over the ${maxBytes}-byte upload limit`);
		if (cur.length >= maxItems || bytes + size > maxBytes) {
			chunks.push(cur);
			cur = [];
			bytes = overhead;
		}
		cur.push(item);
		bytes += size;
	}
	if (cur.length > 0) chunks.push(cur);
	return chunks;
}

// ---- the report (counts only)

const fmt = (n: number): string => n.toLocaleString("en-US");
const usd = (n: number): string => `$${n.toFixed(2)}`;

function countLines(counts: Counts): string[] {
	const entries = Object.entries(counts)
		.filter(([k, v]) => k !== "items" && v > 0)
		.sort(([a], [b]) => a.localeCompare(b));
	const read = entries.filter(([k]) => !k.startsWith("skipped_"));
	const skipped = entries.filter(([k]) => k.startsWith("skipped_"));
	return [
		...(read.length > 0 ? [`  read:    ${read.map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}`] : []),
		...(skipped.length > 0
			? [`  skipped: ${skipped.map(([k, v]) => `${k.slice("skipped_".length)} ${fmt(v)}`).join(" · ")}`]
			: []),
	];
}

function report(d: CommandDeps, r: ImportResult, sha256: string, fileCount: number): void {
	d.out(`${r.source_type}: ${fileCount} file${fileCount === 1 ? "" : "s"}, sha256 ${sha256.slice(0, 16)}…`);
	for (const l of countLines(r.counts)) d.out(l);
	const extract = r.estimate.turns > 0 ? ` (${fmt(r.estimate.turns)} messages for the extractor)` : "";
	d.out(`  items:   ${fmt(r.estimate.item_count)}${extract}, ${fmt(r.estimate.chars)} characters`);
}

// ---- the command

function parse(o: ImportOptions, dirs: UserDirs): { result: ImportResult; sha256: string; fileCount: number } {
	const since = parseDateFlag(o.since, "start");
	const until = parseDateFlag(o.until, "end");
	if (since && until && since > until) throw new Error("--since is after --until");
	const minTurns = o.conversationMinUserTurns ?? DEFAULT_MIN_USER_TURNS;
	if (!Number.isInteger(minTurns) || minTurns < 1)
		throw new Error("--conversation-min-user-turns must be a whole number ≥ 1");
	const history = (HISTORY_SOURCES as readonly SourceType[]).includes(o.source);
	if (!history && (o.since || o.until || o.conversationMinUserTurns !== undefined))
		throw new Error("--since, --until and --conversation-min-user-turns apply to chat history sources only");
	if (o.vendor !== undefined && o.source !== "paste") throw new Error("--vendor applies to --source paste only");
	const input = loadInput(o.source, o.target, dirs);
	const result = runImporter(o.source, input.files, {
		vendor: o.vendor,
		since,
		until,
		conversationMinUserTurns: minTurns,
	});
	return { result, sha256: input.sha256, fileCount: input.fileCount };
}

export async function importCommand(
	d: CommandDeps,
	o: ImportOptions,
	dirs: UserDirs = userDirs(os.homedir(), process.env),
): Promise<void> {
	if (o.resume !== undefined && o.mode !== "commit") throw new Error("--resume goes with --commit");
	const { result, sha256, fileCount } = parse(o, dirs);
	report(d, result, sha256, fileCount);
	if (o.mode === "dry-run") await dryRun(d, o, result, sha256);
	else await commit(d, o, result, sha256);
}

async function dryRun(d: CommandDeps, o: ImportOptions, r: ImportResult, sha256: string): Promise<void> {
	const body = {
		source_type: r.source_type,
		file_sha256: sha256,
		...r.estimate,
		...(o.since ? { since: o.since } : {}),
		...(o.until ? { until: o.until } : {}),
	};
	const e = await d.store.request<EstimateT>("POST", "/v1/import/estimate", body, CALL_TIMEOUT_MS);
	if (!e) throw new StoreError("rejected", "the store gave no estimate");
	d.out(
		`estimate: ${usd(e.estimate_usd)} (≈ ${fmt(e.input_tokens)} input + ${fmt(e.output_tokens)} output tokens; ${fmt(e.cache_hits)} cached); import budget left ${usd(e.import_budget_remaining_usd)}`,
	);
	recordDryRun(
		d.paths,
		{
			source_type: r.source_type,
			file_sha256: sha256,
			at: new Date(d.now()).toISOString(),
			item_count: r.estimate.item_count,
			estimate_usd: e.estimate_usd,
		},
		d.now(),
	);
	if (r.items.length === 0) d.out("nothing to import");
	else d.out(`dry run recorded; within 24 hours, run the same command with --commit instead of --dry-run`);
}

/** Opens (or reopens) the batch: the owner's approval in aws mode, the local token in local mode. */
async function openBatch(
	d: CommandDeps,
	args: Record<string, unknown>,
	resume: string | undefined,
): Promise<{ batchId: string; stepUp: string | undefined }> {
	if (d.config.store.mode === "local") {
		const r = await d.store.request<{ import_batch_id?: string }>("POST", "/v1/admin/import", args, CALL_TIMEOUT_MS);
		return { batchId: checkedBatch(r?.import_batch_id, resume), stepUp: undefined };
	}
	const a = await approve(d, "import", args);
	return { batchId: checkedBatch(a.importBatchId, resume), stepUp: a.token };
}

/** The batch the store opened, which must be the one resumed, if any. */
function checkedBatch(batchId: string | undefined, resume: string | undefined): string {
	if (!batchId) throw new StoreError("rejected", "the store opened no import batch");
	if (resume !== undefined && batchId !== resume)
		throw new StoreError("rejected", `the store opened batch ${batchId}, not ${resume}`);
	return batchId;
}

async function commit(d: CommandDeps, o: ImportOptions, r: ImportResult, sha256: string): Promise<void> {
	const run = findDryRun(d.paths, r.source_type, sha256, d.now());
	if (!run)
		throw new Error(
			`run the same command with --dry-run first: --commit needs a dry run of this input (sha256 ${sha256.slice(0, 16)}…) in the last 24 hours`,
		);
	if (r.items.length === 0) {
		d.out("nothing to import");
		return;
	}
	const args = {
		source_type: r.source_type,
		file_sha256: sha256,
		item_count: r.items.length,
		estimate_usd: run.estimate_usd,
		chars: r.estimate.chars,
		...(o.resume ? { resume_batch_id: o.resume } : {}),
	};
	const { batchId, stepUp } = await openBatch(d, args, o.resume);
	d.out(`batch ${batchId}: uploading ${fmt(r.items.length)} items`);
	const sent = { items: 0, accepted: 0, already: 0, queued: 0 };
	for (const items of chunkItems(batchId, r.items)) {
		let u: UploadT | undefined;
		try {
			u = await d.store.request<UploadT>(
				"POST",
				"/v1/admin/import",
				{ batch_id: batchId, items },
				UPLOAD_TIMEOUT_MS,
				stepUp ? { stepUp } : {},
			);
		} catch (e) {
			if (e instanceof StoreError)
				throw new StoreError(e.kind, `${e.message}; resume with --commit --resume ${batchId}`, e.status, e.body);
			throw e;
		}
		sent.items += items.length;
		sent.accepted += u?.accepted ?? 0;
		sent.already += u?.already ?? 0;
		sent.queued += u?.queued ?? 0;
		d.out(
			`  uploaded ${fmt(sent.items)}/${fmt(r.items.length)} (accepted ${fmt(sent.accepted)}, already ${fmt(sent.already)}, queued for extraction ${fmt(sent.queued)})`,
		);
	}
	const final = await waitForBatch(d, batchId);
	d.out(
		`batch ${batchId}: ${final.status}; cost ${usd(final.cost_usd)} of the ${usd(final.estimate_usd)} estimate, budget ${usd(final.budget_usd)}`,
	);
	for (const l of countLines(final.counts)) d.out(l);
	if (final.status === "aborted_budget") {
		d.out(
			`the batch reached its budget of ${usd(final.budget_usd)} (the amount you approved), or the import budget of all imports ran out; items already processed stay. ` +
				`Resume with --commit --resume ${batchId} and approve a new amount (raise [llm] import_usd_cap first if that ran out)`,
		);
	}
}

/** Polls the batch until extraction is done, printing progress when it changes. */
async function waitForBatch(d: CommandDeps, batchId: string): Promise<BatchStatusT> {
	let lastPending = -1;
	for (;;) {
		const s = await d.store.request<BatchStatusT>(
			"GET",
			`/v1/import/batches/${encodeURIComponent(batchId)}`,
			undefined,
			CALL_TIMEOUT_MS,
		);
		if (!s) throw new StoreError("rejected", `the store does not know batch ${batchId}`);
		if (s.status !== "running") return s;
		if (s.pending !== lastPending) {
			d.out(`  extracting: ${fmt(s.pending)} items left (cost so far ${usd(s.cost_usd)})`);
			lastPending = s.pending;
		}
		await d.sleep(POLL_MS);
	}
}
