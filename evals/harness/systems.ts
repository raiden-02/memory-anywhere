// Ranking systems beyond BM25 for suite R (evals.md §7): for each candidate embedding model,
// vector-only (top 50 by dot product) and hybrid (RRF of BM25 top 50 and vector top 50,
// retrieval.md §2); the full system; and the external baselines (mem0, mcp-memory-service),
// which run in Docker and are driven through the adapter contract (evals.md §8.1).
// Document vectors come from the embedding benchmark's cache in evals/embed (computed and cached
// on first use; DirectML on Windows when available), queries are embedded on CPU.
// Models must have been fetched (node evals/embed/fetch-models.ts); missing ones are
// skipped with a notice, so `pnpm eval run --suite R` always prints at least BM25.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bm25Rank } from "../adapters/bm25.ts";
import { docVectors, rrf, topByDot } from "../embed/bench.ts";
import { Embedder } from "../embed/embedder.ts";
import { modelDir } from "../embed/fetch-models.ts";
import { CANDIDATES, type Candidate } from "../embed/models.ts";
import type { Capabilities, ExternalAdapter, MemoryAdapter } from "../adapters/contract.ts";
import { MCP_MEMORY_SERVICE_CAPABILITIES, McpMemoryServiceAdapter } from "../adapters/mcp-memory-service.ts";
import { MEM0_CAPABILITIES, Mem0Adapter } from "../adapters/mem0.ts";
import { EVAL_CLIENT, lmeDate, memoryAnywhereRank } from "../adapters/memory-anywhere.ts";
import { activeModel } from "../../packages/server/src/embed/manifest.ts";
import { OnnxEmbedder } from "../../packages/server/src/embed/onnx.ts";
import type { RetrievalItem } from "./lme.ts";
import type { RankingSystem } from "./suite-r.ts";

function modelPresent(c: Candidate): boolean {
	return c.files.every((f) => existsSync(join(modelDir(c), f)));
}

/** Lazily loaded embedders, shared by a model's vector and hybrid systems. */
function embeddersFor(c: Candidate) {
	let corpus: Promise<Embedder> | undefined;
	let query: Promise<Embedder> | undefined;
	const qCache = new Map<string, Float32Array>();
	return async (item: RetrievalItem) => {
		corpus ??= Embedder.load(c, { device: process.platform === "win32" ? "dml" : "cpu" });
		query ??= Embedder.load(c, { device: "cpu" });
		const docs = await docVectors(await corpus, item);
		let q = qCache.get(item.qid);
		if (!q) {
			q = (await (await query).embed([item.query], "query"))[0] ?? new Float32Array();
			qCache.set(item.qid, q);
		}
		return topByDot(q, item.docs, docs);
	};
}

export async function systemsFromRegistry(requested: string | undefined): Promise<RankingSystem[]> {
	const wanted = requested?.split(",");
	const systems: RankingSystem[] = [];
	for (const c of CANDIDATES) {
		const names = [`vector:${c.id}`, `hybrid:${c.id}`];
		if (wanted && !names.some((n) => wanted.includes(n))) continue;
		if (!modelPresent(c)) {
			process.stderr.write(`skipping ${c.id}: model not fetched (node evals/embed/fetch-models.ts)\n`);
			continue;
		}
		const vectorTop = embeddersFor(c);
		const need = (item: RetrievalItem | undefined): RetrievalItem => {
			if (!item) throw new Error("vector systems need the question item");
			return item;
		};
		systems.push({ name: `vector:${c.id}`, rank: async (_d, _q, item) => vectorTop(need(item)) });
		systems.push({
			name: `hybrid:${c.id}`,
			rank: async (docs, q, item) => rrf([bm25Rank(docs, q), await vectorTop(need(item))]),
		});
	}
	return systems;
}

/**
 * The full system: the server's ranking over a store seeded with each haystack.
 * Document vectors are the pinned model's cached ones; queries go through the server's embedder.
 */
export function memoryAnywhereSystem(): RankingSystem | undefined {
	const c = CANDIDATES.find((x) => x.id === activeModel().name);
	if (!c || !modelPresent(c)) {
		process.stderr.write(
			"skipping memory-anywhere: the pinned model is not fetched (node evals/embed/fetch-models.ts)\n",
		);
		return undefined;
	}
	let corpus: Promise<Embedder> | undefined;
	let query: Promise<OnnxEmbedder> | undefined;
	return {
		name: "memory-anywhere",
		rank: async (_docs, q, item) => {
			if (!item) throw new Error("memory-anywhere needs the question item");
			corpus ??= Embedder.load(c, { device: process.platform === "win32" ? "dml" : "cpu" });
			query ??= OnnxEmbedder.load(modelDir(c), activeModel());
			const vectors = await docVectors(await corpus, item);
			const seeded = item.docs.map((d, i) => ({
				...d,
				at: d.date ? lmeDate(d.date) : 0,
				vector: vectors[i] ?? new Float32Array(c.dims),
			}));
			return memoryAnywhereRank(await query, seeded, q, item.questionDate ? lmeDate(item.questionDate) : Date.now());
		},
	};
}

/** The external baselines (evals.md §7), each run in Docker behind the adapter contract (§8.1). */
export const EXTERNAL_SYSTEMS = {
	mem0: MEM0_CAPABILITIES,
	"mcp-memory-service": MCP_MEMORY_SERVICE_CAPABILITIES,
} as const satisfies Record<string, Capabilities>;
export type ExternalSystem = keyof typeof EXTERNAL_SYSTEMS;

export function isExternalSystem(name: string): name is ExternalSystem {
	return Object.hasOwn(EXTERNAL_SYSTEMS, name);
}

/**
 * Start an external baseline. mem0 stores each text as is (infer: false): suite R indexes the same
 * rounds in every system (evals.md §3.2), and its LLM extraction is not what R scores.
 */
export function startExternal(name: ExternalSystem, log: (line: string) => void): Promise<ExternalAdapter> {
	return name === "mem0" ? Mem0Adapter.start({ infer: false, log }) : McpMemoryServiceAdapter.start({ log });
}

/** Results recalled per question: the depth nDCG@10 reads. */
const RECALL_K = 10;

/**
 * A system behind the adapter contract as a suite R ranking: for each question the store is
 * emptied, the haystack saved through the system's own write call (one memory per round, in
 * order, each with its session and date), and the question recalled through its own read call.
 * Recalled ids map back to rounds; a memory that holds two identical rounds stands for both.
 * A save or recall the system refuses is counted, logged and scored as a miss, not retried.
 */
export function adapterSystem(
	adapter: MemoryAdapter & { describe?(): Record<string, unknown> },
	log: (line: string) => void = () => {},
): RankingSystem {
	const counts = { questions: 0, rounds: 0, not_stored: 0, failed_saves: 0, failed_recalls: 0 };
	return {
		name: adapter.name,
		info: () => ({
			...(adapter.describe?.() ?? {}),
			capabilities: adapter.capabilities(),
			recall_k: RECALL_K,
			counts: { ...counts },
		}),
		rank: async (docs, query, item) => {
			await adapter.reset();
			const roundsOf = new Map<string, string[]>();
			for (const d of docs) {
				counts.rounds++;
				try {
					const at = new Date(d.date ? lmeDate(d.date) : 0).toISOString();
					const saved = await adapter.save(
						{ content: d.text },
						{ client: EVAL_CLIENT, session: d.id.split("#")[0] ?? d.id, at },
					);
					if (saved.id) roundsOf.set(saved.id, [...(roundsOf.get(saved.id) ?? []), d.id]);
					else counts.not_stored++;
				} catch (e) {
					counts.failed_saves++;
					log(`${adapter.name}: save of ${d.id} failed: ${(e as Error).message.slice(0, 200)}`);
				}
			}
			counts.questions++;
			if (counts.questions % 25 === 0) log(`${adapter.name}: ${counts.questions} questions`);
			try {
				const recalled = await adapter.recall(query, RECALL_K, { client: EVAL_CLIENT });
				return recalled.flatMap((r) => roundsOf.get(r.id) ?? []);
			} catch (e) {
				counts.failed_recalls++;
				log(`${adapter.name}: recall for ${item?.qid ?? query} failed: ${(e as Error).message.slice(0, 200)}`);
				return [];
			}
		},
	};
}

export function gitSha(): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}
