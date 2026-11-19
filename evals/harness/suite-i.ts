// Suite I (evals.md §3, importers.md §6): the real importers read the synthetic exports of
// evals/datasets/i/imports (persona Alex), and the server's import functions write them through the
// real save path, each case on a fresh in-memory store. The extractor is scripted (no key, no
// network), so everything after the model is under test: the span check, the decision rows, the
// store rules and the import bookkeeping.
//
//   fixture ─runImporter─► items ─createBatch + upload─► atomic: save() now
//                                                        extract: job ─scripted extractor─► span check ─► save()
//
// Three measurements:
//   re-import no-op    every fixture imported twice; the content hash after the second import
//                      equals the one after the first (gate: every fixture)
//   duplicate rate     the labelled pair (the same 20 facts as a Claude list and a ChatGPT list) in
//                      one store; a stored memory is a duplicate when another current memory holds
//                      the same labelled fact (gate: ≤ 5%)
//   false merges       the distinct pair (22 near but different facts, the same two sources): an item
//                      of the second list landing in a memory of the first is a false merge (gate: 0
//                      of ≥ 20); each line's cosine is recorded, so the margin to the thresholds shows
//   extraction         precision and recall of what the extract sources stored against their
//                      labels; the script states every labelled fact plus noise the span check must
//                      drop and noise it cannot (reported, author-labelled)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { norm } from "@memory-anywhere/contracts/normalize";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import {
	runImporter,
	type ImportResult,
	type SourceFile,
	type SourceType,
} from "../../packages/importers/src/index.ts";
import { App } from "../../packages/server/src/app.ts";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import type { Embedder } from "../../packages/server/src/embed/types.ts";
import { JobWorker } from "../../packages/server/src/jobs/worker.ts";
import type { LlmProvider, ProviderReply } from "../../packages/server/src/llm/adapter.ts";
import type { ExtractOutputT, LlmCall } from "../../packages/server/src/llm/prompts.ts";
import { steppingClock } from "../../packages/server/src/store/clock.ts";
import { openStore } from "../../packages/server/src/store/db.ts";
import { contentHash } from "../../packages/server/src/store/dump.ts";
import { INITIAL_THRESHOLDS, initStore } from "../../packages/server/src/store/init.ts";
import { migrate } from "../../packages/server/src/store/migrate.ts";
import { batchStatus, createBatch, estimate, upload } from "../../packages/server/src/write/imports.ts";
import { wilson } from "./stats.ts";

export const DATA_DIR = join(import.meta.dirname, "..", "datasets", "i");
const IMPORTS_DIR = join(DATA_DIR, "imports");

/** The duplicate-rate gate (importers.md §6). */
export const MAX_DUPLICATE_RATE = 0.05;
/** The false-merge gate: no distinct fact may be merged, over at least this many pairs. */
export const MIN_DISTINCT_PAIRS = 20;
/** Sources the extractor reads (importers.md §2–3). */
const EXTRACT_SOURCES: ReadonlySet<SourceType> = new Set([
	"chatgpt-history",
	"claude-history",
	"gemini-history",
	"chatgpt-memory-summary",
	"gemini-memory-summary",
]);
/** Files carry this as their last-written time, so model-written memories get a fixed date. */
const FILE_MTIME = new Date("2026-10-01T12:00:00.000Z");
const START_MS = Date.parse("2026-11-15T12:00:00.000Z");

// ---- the dataset

/** One row of labels.jsonl: the facts a file states and what must not come out of it. */
export interface Label {
	readonly file: string;
	readonly source_type: SourceType;
	/** `paste` only: the app the list came from. */
	readonly vendor?: string;
	/** Where the file lives under the owner's user folder (instruction files, coding-tool memories). */
	readonly install_as?: string;
	/** Files of one labelled pair hold one item per labelled fact, line for line. */
	readonly pair?: string;
	/** A pair whose lines are near but distinct facts (they must stay apart); otherwise its lines are the same facts. */
	readonly distinct?: boolean;
	readonly facts: readonly string[];
	readonly absent: readonly string[];
}

export function loadLabels(): Label[] {
	return readFileSync(join(IMPORTS_DIR, "labels.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Label);
}

/** One answer of the scripted extractor (evals/datasets/i/fake-extractor.json). */
export interface ScriptedItem {
	/** The labelled fact it states; null for noise. */
	readonly label: string | null;
	readonly content: string;
	readonly kind: "fact" | "preference" | "event";
	readonly span: string;
	/** Text of the message it is answered for; the span when absent. */
	readonly anchor?: string;
	readonly entity?: string;
	readonly note?: string;
}

export function loadScript(): Partial<Record<SourceType, ScriptedItem[]>> {
	return (
		JSON.parse(readFileSync(join(DATA_DIR, "fake-extractor.json"), "utf8")) as {
			sources: Partial<Record<SourceType, ScriptedItem[]>>;
		}
	).sources;
}

/** What one import reads: a source's files, as `mema import` would pass them to the importer. */
export interface Fixture {
	readonly name: string;
	readonly source: SourceType;
	readonly labels: readonly Label[];
}

/** One fixture per source over its files, and one per file of a labelled pair. */
export function fixtures(labels: readonly Label[]): Fixture[] {
	const out: Fixture[] = [];
	for (const l of labels.filter((x) => x.pair !== undefined))
		out.push({ name: l.file, source: l.source_type, labels: [l] });
	const bySource = new Map<SourceType, Label[]>();
	for (const l of labels.filter((x) => x.pair === undefined))
		bySource.set(l.source_type, [...(bySource.get(l.source_type) ?? []), l]);
	for (const [source, ls] of bySource) out.push({ name: source, source, labels: ls });
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Runs the real importer over a fixture's files; the hash is the one `loadInput` gives the same files. */
export function readFixture(f: Fixture): { result: ImportResult; fileSha256: string } {
	const files: SourceFile[] = f.labels.map((l) => ({
		name: l.install_as ?? l.file,
		text: readFileSync(join(IMPORTS_DIR, l.file), "utf8"),
		mtime: FILE_MTIME,
	}));
	const result = runImporter(f.source, files, { vendor: f.labels[0]?.vendor });
	const hashes = files.map((x) => `${x.name}\u0000${sha256(x.text)}`).sort();
	const fileSha256 = files.length === 1 ? sha256(files[0]?.text ?? "") : sha256(hashes.join("\n"));
	return { result, fileSha256 };
}

// ---- the scripted extractor

/** Answers `extract` from the script: each item whose anchor is in one of the call's messages, quoting that message's id; every other call with "none". */
export function scriptedExtractor(
	script: readonly ScriptedItem[],
): LlmProvider & { readonly calls: Record<string, number> } {
	const calls: Record<string, number> = {};
	return {
		modelId: "claude-haiku-5-5",
		calls,
		async ask<T>(call: LlmCall<T>): Promise<ProviderReply<T>> {
			calls[call.name] = (calls[call.name] ?? 0) + 1;
			if (call.name !== "extract") {
				const none = call.name === "slot_proposal" ? { attribute: "none" } : { sensitive_category: "none" };
				return { value: none as T, tokensIn: 0, tokensOut: 0 };
			}
			const messages = JSON.parse(call.user.replace(/^Messages: /u, "")) as { id: string; text: string }[];
			const items: ExtractOutputT["items"] = [];
			for (const s of script) {
				const anchor = norm(s.anchor ?? s.span);
				const m = messages.find((x) => norm(x.text).includes(anchor));
				if (m)
					items.push({
						content: s.content,
						kind: s.kind,
						span: s.span,
						prompt_id: m.id,
						attribute: null,
						entity: s.entity ?? null,
					});
			}
			const value: ExtractOutputT = { items };
			return {
				value: value as T,
				tokensIn: Math.ceil(call.user.length / 4),
				tokensOut: Math.ceil(JSON.stringify(value).length / 4),
			};
		},
	};
}

// ---- one store, one import

interface Store {
	readonly app: App;
	close(): void;
}

async function freshStore(embedder: Embedder, provider: LlmProvider): Promise<Store> {
	const db = openStore(":memory:", { mode: "local" });
	await migrate(db, undefined);
	const clock = steppingClock(START_MS, 1000);
	const ids = idSource(seededPrng(17));
	initStore(
		{ db, clock, ids },
		{
			embedding: { modelId: embedder.modelId, dim: embedder.dim, queryPrefix: "", docPrefix: "", filesSha256: {} },
			localClient: undefined,
		},
	);
	const base = defaultConfig();
	const config = { ...base, llm: { ...base.llm, provider: "anthropic" as const } };
	const app = new App({ db, config, embedder, clock, ids, llmProvider: provider });
	return { app, close: () => db.close() };
}

export interface ImportRun {
	readonly batch_id: string;
	readonly items: number;
	readonly accepted: number;
	readonly already: number;
	readonly queued: number;
	readonly status: string;
	readonly counts: Record<string, number>;
}

/** One `mema import --commit` after an approved step-up: estimate, batch, upload, then the worker until no job is due. */
async function importOnce(app: App, f: Fixture): Promise<ImportRun & { readonly result: ImportResult }> {
	const { result, fileSha256 } = readFixture(f);
	const est = estimate(app.ctx, app.llm, app.config.llm.import_usd_cap, {
		source_type: f.source,
		file_sha256: fileSha256,
		...result.estimate,
	});
	const batch = createBatch(app.ctx, {
		source_type: f.source,
		file_sha256: fileSha256,
		item_count: Math.max(1, result.items.length),
		estimate_usd: est.estimate_usd,
	});
	if (!batch.ok) throw new Error(`${f.name}: ${batch.message}`);
	let accepted = 0;
	let already = 0;
	let queued = 0;
	for (let i = 0; i < result.items.length; i += 100) {
		const r = await upload(app.write, batch.batchId, result.items.slice(i, i + 100));
		accepted += r.accepted;
		already += r.already;
		queued += r.queued;
	}
	const worker = new JobWorker(app);
	while (await worker.tick()) {
		/* one job per tick */
	}
	const status = batchStatus(app.ctx, batch.batchId);
	return {
		batch_id: batch.batchId,
		items: result.items.length,
		accepted,
		already,
		queued,
		status: status?.status ?? "missing",
		counts: status?.counts ?? {},
		result,
	};
}

// ---- re-import no-op

export interface ReimportRow {
	readonly fixture: string;
	readonly source_type: SourceType;
	readonly items: number;
	readonly first: { accepted: number; queued: number; status: string };
	readonly second: { accepted: number; already: number; status: string };
	readonly content_hash_equal: boolean;
}

async function reimport(f: Fixture, embedder: Embedder, script: readonly ScriptedItem[]): Promise<ReimportRow> {
	const store = await freshStore(embedder, scriptedExtractor(script));
	try {
		const first = await importOnce(store.app, f);
		const after1 = contentHash(store.app.ctx.db);
		const second = await importOnce(store.app, f);
		return {
			fixture: f.name,
			source_type: f.source,
			items: first.items,
			first: { accepted: first.accepted, queued: first.queued, status: first.status },
			second: { accepted: second.accepted, already: second.already, status: second.status },
			content_hash_equal: contentHash(store.app.ctx.db) === after1,
		};
	} finally {
		store.close();
	}
}

// ---- the labelled pairs: duplicates and false merges

/** Memories that hold a fact now: what recall can return or the owner is reviewing. */
const CURRENT = "('active','contested','pending_review')";

/** One line of a labelled pair: what each file's item became, and how close their embeddings are. */
interface PairLine {
	readonly first: { fact: string; content: string; memoryId: string | null; current: boolean };
	readonly second: { fact: string; content: string; memoryId: string | null; current: boolean; outcome: string };
	readonly cosine: number;
}

const dot = (a: Float32Array, b: Float32Array): number => {
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		d += (a[i] ?? 0) * (b[i] ?? 0);
		na += (a[i] ?? 0) ** 2;
		nb += (b[i] ?? 0) ** 2;
	}
	return d / Math.sqrt(na * nb);
};

/** Imports the pair's two files, in order, into one fresh store; line i of one file is line i of the other. */
async function importPair(pair: readonly [Fixture, Fixture], embedder: Embedder): Promise<PairLine[]> {
	const store = await freshStore(embedder, scriptedExtractor([]));
	try {
		const { db } = store.app.ctx;
		const sides = [];
		for (const f of pair) {
			const run = await importOnce(store.app, f);
			const facts = f.labels[0]?.facts ?? [];
			if (run.result.items.length !== facts.length)
				throw new Error(`${f.name}: ${run.result.items.length} items for ${facts.length} labelled facts`);
			sides.push(
				run.result.items.map((item, i) => {
					const row = db
						.prepare("SELECT outcome, reason, memory_id FROM import_item WHERE idempotency_key = ?")
						.get(item.key) as { outcome: string; reason: string; memory_id: string | null };
					const current =
						row.memory_id !== null &&
						db.prepare(`SELECT 1 FROM memory WHERE id = ? AND status IN ${CURRENT}`).get(row.memory_id) !== undefined;
					return {
						fact: facts[i] ?? "",
						content: item.content ?? "",
						memoryId: row.memory_id,
						current,
						outcome: `${row.outcome}.${row.reason}`,
					};
				}),
			);
		}
		const [a = [], b = []] = sides;
		const va = await embedder.embedDocuments(a.map((x) => x.content));
		const vb = await embedder.embedDocuments(b.map((x) => x.content));
		return a.map((first, i) => ({
			first,
			second: b[i] ?? { fact: "", content: "", memoryId: null, current: false, outcome: "missing" },
			cosine: Math.round(dot(va[i] ?? new Float32Array(), vb[i] ?? new Float32Array()) * 1000) / 1000,
		}));
	} finally {
		store.close();
	}
}

export interface DuplicateResult {
	readonly pair: string;
	readonly facts: number;
	readonly stored: number;
	readonly duplicates: number;
	readonly rate: number;
	readonly ci95: [number, number];
	/** Labelled facts held by more than one current memory. */
	readonly duplicated: string[];
	/** What each item of the second file became, by outcome and reason. */
	readonly outcomes: Record<string, number>;
	/** Each fact's two texts and their cosine, so the margin to the thresholds is visible. */
	readonly lines: { fact: string; first: string; second: string; cosine: number; merged: boolean }[];
}

/** Same facts in two sources: a stored memory is a duplicate when another current memory holds the same fact. */
async function duplicateRate(pair: readonly [Fixture, Fixture], embedder: Embedder): Promise<DuplicateResult> {
	const lines = await importPair(pair, embedder);
	let stored = 0;
	const duplicated: string[] = [];
	const outcomes: Record<string, number> = {};
	for (const l of lines) {
		outcomes[l.second.outcome] = (outcomes[l.second.outcome] ?? 0) + 1;
		const current = new Set([l.first, l.second].filter((x) => x.current).map((x) => x.memoryId));
		stored += current.size;
		if (current.size > 1) duplicated.push(l.first.fact);
	}
	const w = wilson(duplicated.length, stored);
	return {
		pair: pair[0].labels[0]?.pair ?? "",
		facts: lines.length,
		stored,
		duplicates: duplicated.length,
		rate: w.p,
		ci95: w.ci95,
		duplicated,
		outcomes,
		lines: lines.map((l) => ({
			fact: l.first.fact,
			first: l.first.content,
			second: l.second.content,
			cosine: l.cosine,
			merged: l.first.memoryId === l.second.memoryId,
		})),
	};
}

export interface FalseMergeResult {
	readonly pair: string;
	readonly n: number;
	readonly false_merges: number;
	readonly upper95: number;
	/** The highest cosine between two distinct facts: the margin below the merge thresholds. */
	readonly max_cosine: number;
	readonly merged: string[];
	readonly lines: { first: string; second: string; cosine: number; merged: boolean }[];
}

/** Near but distinct facts in two sources: the second file's item must never land in a memory the first file's items made. */
async function falseMerges(pair: readonly [Fixture, Fixture], embedder: Embedder): Promise<FalseMergeResult> {
	const lines = await importPair(pair, embedder);
	const firstIds = new Set(lines.map((l) => l.first.memoryId).filter((x) => x !== null));
	const rows = lines.map((l) => ({
		first: l.first.content,
		second: l.second.content,
		cosine: l.cosine,
		merged: l.second.memoryId !== null && firstIds.has(l.second.memoryId),
	}));
	const merged = rows.filter((r) => r.merged).map((r) => `${r.first} | ${r.second}`);
	return {
		pair: pair[0].labels[0]?.pair ?? "",
		n: rows.length,
		false_merges: merged.length,
		upper95: wilson(merged.length, rows.length).ci95[1],
		max_cosine: Math.max(...rows.map((r) => r.cosine)),
		merged,
		lines: rows,
	};
}

// ---- extraction precision and recall

export interface ExtractionRow {
	readonly source_type: SourceType;
	/** Current memories and open observations the import left. */
	readonly stored: number;
	readonly stored_labelled: number;
	readonly labelled_facts: number;
	readonly facts_found: number;
	/** Labelled facts the script states but nothing stored holds. */
	readonly missed: string[];
	/** Stored contents that state no labelled fact. */
	readonly unlabelled_stored: string[];
	readonly counts: Record<string, number>;
	readonly llm_calls: Record<string, number>;
}

async function extraction(f: Fixture, embedder: Embedder, script: readonly ScriptedItem[]): Promise<ExtractionRow> {
	const facts = f.labels.flatMap((l) => l.facts);
	const unknown = script.filter((s) => s.label !== null && !facts.includes(s.label));
	if (unknown.length > 0)
		throw new Error(
			`${f.source}: the script states facts that are not labelled: ${unknown.map((s) => s.label).join("; ")}`,
		);
	const provider = scriptedExtractor(script);
	const store = await freshStore(embedder, provider);
	try {
		const run = await importOnce(store.app, f);
		const contents = (
			store.app.ctx.db
				.prepare(
					`SELECT v.content FROM memory m JOIN memory_version v ON v.memory_id = m.id
         WHERE m.status IN ${CURRENT} AND v.valid_to IS NULL AND v.expired_at IS NULL
       UNION ALL SELECT content FROM observation WHERE status = 'open'`,
				)
				.all() as { content: string }[]
		).map((r) => r.content);
		const labelOf = new Map(script.map((s) => [norm(s.content), s.label]));
		const found = new Set<string>();
		const unlabelled: string[] = [];
		for (const c of contents) {
			const label = labelOf.get(norm(c));
			if (label) found.add(label);
			else unlabelled.push(c);
		}
		return {
			source_type: f.source,
			stored: contents.length,
			stored_labelled: contents.length - unlabelled.length,
			labelled_facts: facts.length,
			facts_found: found.size,
			missed: facts.filter((x) => !found.has(x)),
			unlabelled_stored: unlabelled,
			counts: run.counts,
			llm_calls: { ...provider.calls },
		};
	} finally {
		store.close();
	}
}

// ---- the suite

export interface SuiteIResult {
	readonly suite: "I";
	readonly system: "memory-anywhere";
	readonly dataset: string;
	/** Synthetic exports labelled by their author (evals.md §6): gates on re-import and duplicates, extraction reported only. */
	readonly labels: "author-labelled";
	readonly llm: "scripted-extractor";
	readonly embedding_model: string;
	readonly gate: {
		readonly reimport: { fixtures: number; unchanged: number; pass: boolean };
		readonly duplicates: { k: number; n: number; rate: number; ci95: [number, number]; max: number; pass: boolean };
		readonly false_merges: { k: number; n: number; upper95: number; pass: boolean };
		readonly pass: boolean;
	};
	/** Store rule 6's cosines (write-path.md §8): the store's dup_threshold, and the server config's import and extension values. */
	readonly thresholds: {
		dup_threshold: number;
		import_dup_threshold: number;
		reworded_min_cosine: number;
		extension_min_cosine: number;
	};
	readonly reimport: ReimportRow[];
	readonly duplicates: DuplicateResult;
	readonly false_merges: FalseMergeResult;
	readonly extraction: {
		readonly precision: { k: number; n: number; p: number; ci95: [number, number] };
		readonly recall: { k: number; n: number; p: number; ci95: [number, number] };
		readonly per_source: ExtractionRow[];
	};
}

/** The labelled pair of each kind; the Claude list first, as the owner would import the app used first. */
function pairOf(all: readonly Fixture[], distinct: boolean): [Fixture, Fixture] {
	const files = all.filter((f) => f.labels[0]?.pair !== undefined && (f.labels[0]?.distinct ?? false) === distinct);
	const [a, b] = [...files].sort((x, y) => y.source.localeCompare(x.source));
	if (!a || !b || files.length !== 2)
		throw new Error(`labels.jsonl needs one ${distinct ? "distinct" : "same-facts"} pair of two files`);
	return [a, b];
}

export async function runSuiteI(
	embedder: Embedder,
	log: (line: string) => void = () => undefined,
): Promise<SuiteIResult> {
	const labels = loadLabels();
	const script = loadScript();
	const all = fixtures(labels);
	const reimportRows: ReimportRow[] = [];
	for (const f of all) {
		log(`re-import ${f.name}`);
		reimportRows.push(await reimport(f, embedder, script[f.source] ?? []));
	}
	log("duplicates");
	const duplicates = await duplicateRate(pairOf(all, false), embedder);
	log("false merges");
	const merges = await falseMerges(pairOf(all, true), embedder);
	const perSource: ExtractionRow[] = [];
	for (const f of all.filter((x) => EXTRACT_SOURCES.has(x.source) && x.labels[0]?.pair === undefined)) {
		log(`extraction ${f.source}`);
		perSource.push(await extraction(f, embedder, script[f.source] ?? []));
	}
	const sum = (pick: (r: ExtractionRow) => number): number => perSource.reduce((s, r) => s + pick(r), 0);
	const rate = (k: number, n: number) => ({ k, n, ...wilson(k, n) });
	const unchanged = reimportRows.filter((r) => r.content_hash_equal).length;
	const reimportPass = unchanged === reimportRows.length && reimportRows.length > 0;
	const dupPass = duplicates.stored > 0 && duplicates.rate <= MAX_DUPLICATE_RATE;
	const mergePass = merges.false_merges === 0 && merges.n >= MIN_DISTINCT_PAIRS;
	const config = defaultConfig();
	return {
		suite: "I",
		system: "memory-anywhere",
		dataset: `i-synthetic-alex-${labels.length}-files`,
		labels: "author-labelled",
		llm: "scripted-extractor",
		embedding_model: embedder.modelId,
		gate: {
			reimport: { fixtures: reimportRows.length, unchanged, pass: reimportPass },
			duplicates: {
				k: duplicates.duplicates,
				n: duplicates.stored,
				rate: duplicates.rate,
				ci95: duplicates.ci95,
				max: MAX_DUPLICATE_RATE,
				pass: dupPass,
			},
			false_merges: { k: merges.false_merges, n: merges.n, upper95: merges.upper95, pass: mergePass },
			pass: reimportPass && dupPass && mergePass,
		},
		thresholds: {
			dup_threshold: Number(INITIAL_THRESHOLDS.dup_threshold),
			import_dup_threshold: config.write.import_dup_threshold,
			reworded_min_cosine: config.write.reworded_min_cosine,
			extension_min_cosine: config.write.extension_min_cosine,
		},
		reimport: reimportRows,
		duplicates,
		false_merges: merges,
		extraction: {
			precision: rate(
				sum((r) => r.stored_labelled),
				sum((r) => r.stored),
			),
			recall: rate(
				sum((r) => r.facts_found),
				sum((r) => r.labelled_facts),
			),
			per_source: perSource,
		},
	};
}
