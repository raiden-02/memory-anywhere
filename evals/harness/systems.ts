// Ranking systems beyond BM25 for suite R (evals.md §7): for each Q14 candidate model,
// vector-only (top 50 by dot product) and hybrid (RRF of BM25 top 50 and vector top 50,
// retrieval.md §2). Document vectors come from spikes/embed-bench's cache (computed and cached
// on first use; DirectML on Windows when available), queries are embedded on CPU.
// Models must have been fetched (node spikes/embed-bench/src/fetch-models.ts); missing ones are
// skipped with a notice, so `pnpm eval run --suite R` always prints at least BM25.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bm25Rank } from "../adapters/bm25.ts";
import { docVectors, rrf, topByDot } from "../../spikes/embed-bench/src/bench.ts";
import { Embedder } from "../../spikes/embed-bench/src/embedder.ts";
import { modelDir } from "../../spikes/embed-bench/src/fetch-models.ts";
import { CANDIDATES, type Candidate } from "../../spikes/embed-bench/src/models.ts";
import { lmeDate, memoryAnywhereRank } from "../adapters/memory-anywhere.ts";
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
      process.stderr.write(`skipping ${c.id}: model not fetched (node spikes/embed-bench/src/fetch-models.ts)\n`);
      continue;
    }
    const vectorTop = embeddersFor(c);
    const need = (item: RetrievalItem | undefined): RetrievalItem => {
      if (!item) throw new Error("vector systems need the question item");
      return item;
    };
    systems.push({ name: `vector:${c.id}`, rank: async (_d, _q, item) => vectorTop(need(item)) });
    systems.push({ name: `hybrid:${c.id}`, rank: async (docs, q, item) => rrf([bm25Rank(docs, q), await vectorTop(need(item))]) });
  }
  return systems;
}

/**
 * The full system: the server's ranking over a store seeded with each haystack (spec-issues #26).
 * Document vectors are the pinned model's cached ones; queries go through the server's embedder.
 */
export function memoryAnywhereSystem(): RankingSystem | undefined {
  const c = CANDIDATES.find((x) => x.id === activeModel().name);
  if (!c || !modelPresent(c)) {
    process.stderr.write("skipping memory-anywhere: the pinned model is not fetched (node spikes/embed-bench/src/fetch-models.ts)\n");
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
      const seeded = item.docs.map((d, i) => ({ ...d, at: d.date ? lmeDate(d.date) : 0, vector: vectors[i] ?? new Float32Array(c.dims) }));
      return memoryAnywhereRank(await query, seeded, q, item.questionDate ? lmeDate(item.questionDate) : Date.now());
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
