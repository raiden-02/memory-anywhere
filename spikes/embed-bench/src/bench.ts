// Q14 embed-bench (m0-spike.md, ADR-0005) on the owner's PC:
//   node spikes/embed-bench/src/bench.ts --split dev [--models a,b] [--out file.json]
//
// Quality: each question's rounds are embedded once (DirectML GPU when available, cached under
// out/cache/), queries on CPU; vector = top 50 by dot product; hybrid = reciprocal rank fusion
// (k = 60) of the BM25 top 50 and the vector top 50 (retrieval.md §2 steps 3-4). Scored by
// evals/harness suite R (nDCG@10, R@5, bootstrap CIs).
// Latency and memory: CPU only, as the server runs: per query, embed it and score it against a
// 10,000-vector store (p50/p95 over the split's queries); process RSS with the model loaded.
// Device check: a sample of rounds embedded on both devices must agree (cosine >= 0.999).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bm25Rank } from "../../../evals/adapters/bm25.ts";
import { loadItems } from "../../../evals/harness/cli.ts";
import type { Doc, RetrievalItem } from "../../../evals/harness/lme.ts";
import { compare, runSuiteR, type RankingSystem, type SuiteRResult } from "../../../evals/harness/suite-r.ts";
import { dot, Embedder } from "./embedder.ts";
import { CANDIDATES, type Candidate } from "./models.ts";

const CACHE = join(import.meta.dirname, "..", "out", "cache");
const BATCH = 32;

let corpusDevice: "cpu" | "dml" = process.platform === "win32" ? "dml" : "cpu";

function cacheFile(c: Candidate, qid: string): string {
  return join(CACHE, corpusDevice, c.id, `${qid}.f32`);
}

async function docVectors(e: Embedder, item: RetrievalItem): Promise<Float32Array[]> {
  const file = cacheFile(e.candidate, item.qid);
  const dims = e.candidate.dims;
  if (existsSync(file)) {
    const buf = readFileSync(file);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return item.docs.map((_, i) => all.slice(i * dims, (i + 1) * dims));
  }
  const order = item.docs.map((d, i) => ({ i, len: d.text.length })).sort((a, b) => a.len - b.len);
  const out: Float32Array[] = new Array(item.docs.length);
  for (let s = 0; s < order.length; s += BATCH) {
    const chunk = order.slice(s, s + BATCH);
    const vecs = await e.embed(
      chunk.map((o) => item.docs[o.i]?.text ?? ""),
      "doc",
    );
    chunk.forEach((o, k) => (out[o.i] = vecs[k] ?? new Float32Array(dims)));
  }
  const flat = new Float32Array(out.length * dims);
  out.forEach((v, i) => flat.set(v, i * dims));
  mkdirSync(join(CACHE, corpusDevice, e.candidate.id), { recursive: true });
  writeFileSync(file, Buffer.from(flat.buffer));
  return out;
}

function topByDot(q: Float32Array, docs: Doc[], vecs: Float32Array[], k = 50): string[] {
  return docs
    .map((d, i) => ({ id: d.id, s: dot(q, vecs[i] ?? new Float32Array()) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.id);
}

export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}


async function deviceAgreement(c: Candidate, docs: Doc[]): Promise<number> {
  const cpu = await Embedder.load(c, { device: "cpu" });
  const gpu = await Embedder.load(c, { device: "dml" });
  const texts = docs.slice(0, 32).map((d) => d.text);
  const a = await cpu.embed(texts, "doc");
  const b = await gpu.embed(texts, "doc");
  await cpu.release();
  await gpu.release();
  return Math.min(...a.map((v, i) => dot(v, b[i] ?? new Float32Array())));
}

/** Latency and RSS in a fresh process holding only the model and the vector store. */
function latencyInChild(c: Candidate, queriesFile: string): { p50_ms: number; p95_ms: number; rss_peak_mb: number } & Record<string, unknown> {
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "latency.ts"), c.id, queriesFile], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}") as { p50_ms: number; p95_ms: number; rss_peak_mb: number };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { split: { type: "string", default: "dev" }, models: { type: "string" }, out: { type: "string" }, "corpus-device": { type: "string" } },
  });
  if (values["corpus-device"] === "cpu" || values["corpus-device"] === "dml") corpusDevice = values["corpus-device"];
  const split = values.split === "test" ? "test" : "dev";
  const items = await loadItems(split);
  const chosen = CANDIDATES.filter((c) => !values.models || values.models.split(",").includes(c.id));
  const meta = { dataset: `longmemeval-s-${split === "test" ? 200 : 100}`, split };

  const queriesFile = join(CACHE, `queries-${split}.json`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(queriesFile, JSON.stringify(items.map((i) => i.query)));
  const bm25Lists = new Map(items.map((it) => [it.qid, bm25Rank(it.docs, it.query)]));
  const bm25: RankingSystem = { name: "bm25", rank: (_d, q) => bm25Lists.get(items.find((i) => i.query === q)?.qid ?? "") ?? [] };
  const bm25Result = await runSuiteR(bm25, items, meta);
  const report: { split: string; bm25: SuiteRResult; models: Record<string, unknown>[] } = { split, bm25: bm25Result, models: [] };

  for (const c of chosen) {
    process.stderr.write(`${c.id}: embedding ${items.length} haystacks ...\n`);
    const gpu = await Embedder.load(c, { device: corpusDevice });
    const cpu = await Embedder.load(c, { device: "cpu" });
    const vecByQ = new Map<string, Float32Array[]>();
    const qVec = new Map<string, Float32Array>();
    const t0 = Date.now();
    for (const it of items) {
      vecByQ.set(it.qid, await docVectors(gpu, it));
      qVec.set(it.qid, (await cpu.embed([it.query], "query"))[0] ?? new Float32Array());
    }
    const embedSeconds = (Date.now() - t0) / 1000;
    await gpu.release();
    await cpu.release();
    const byQuery = new Map(items.map((it) => [it.query, it]));
    const vectorList = (q: string) => {
      const it = byQuery.get(q);
      return it ? topByDot(qVec.get(it.qid) ?? new Float32Array(), it.docs, vecByQ.get(it.qid) ?? []) : [];
    };
    const vector = await runSuiteR({ name: `vector:${c.id}`, rank: (_d, q) => vectorList(q) }, items, meta);
    const hybrid = await runSuiteR(
      { name: `hybrid:${c.id}`, rank: (_d, q) => rrf([bm25Lists.get(byQuery.get(q)?.qid ?? "") ?? [], vectorList(q)]) },
      items,
      meta,
    );
    for (const r of [vector, hybrid]) r.comparisons.push(compare(r, bm25Result, "ndcg10"), compare(r, bm25Result, "r5"));
    const agreement = process.platform === "win32" ? await deviceAgreement(c, items[0]?.docs ?? []) : 1;
    const perf = latencyInChild(c, queriesFile);
    const row = { candidate: c, embed_seconds: embedSeconds, device_agreement_min_cosine: agreement, cpu: perf, vector, hybrid };
    report.models.push(row);
    console.log(
      `${c.id.padEnd(24)} hybrid nDCG@10 ${hybrid.metrics.ndcg10.mean.toFixed(3)} [${hybrid.metrics.ndcg10.ci95.map((x) => x.toFixed(3)).join(", ")}]` +
        `  vector ${vector.metrics.ndcg10.mean.toFixed(3)}  p95 ${perf.p95_ms.toFixed(1)} ms  RSS ${perf.rss_peak_mb} MB  cos(cpu,gpu) ${agreement.toFixed(4)}`,
    );
  }
  console.log(`bm25 nDCG@10 ${bm25Result.metrics.ndcg10.mean.toFixed(3)}`);
  if (values.out) writeFileSync(values.out, JSON.stringify(report, (k, v: unknown) => (k === "per_query" ? undefined : v), 2) + "\n");
}

if (import.meta.main) await main();
