// pnpm eval run --suite <R|P|W|C> [--system …] [--split test|dev] [--out <file>] (evals.md §9).
// Needs no API keys. R: with no --system, runs every baseline that is available and the full
// system. P: server stage. W: FactConsolidation cases. C: local latency against an ephemeral server.
// W and C need the pinned model files (MA_TEST_MODEL_DIR, else the M0 spike's download folder).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeModel } from "../../packages/server/src/embed/manifest.ts";
import { OnnxEmbedder } from "../../packages/server/src/embed/onnx.ts";
import { buildCases } from "../datasets/w/build.ts";
import { runSuiteC } from "./suite-c.ts";
import { runSuiteP } from "./suite-p.ts";
import { runSuiteW } from "./suite-w.ts";
import { parseArgs } from "node:util";
import { bm25Rank } from "../adapters/bm25.ts";
import { fetchLongMemEval } from "../datasets/public/fetch-longmemeval.ts";
import { SPLIT_FILE } from "../datasets/public/make-subsets.ts";
import { loadLme, toRetrievalItem, type RetrievalItem } from "./lme.ts";
import { compare, runSuiteR, type RankingSystem, type SuiteRResult } from "./suite-r.ts";
import { gitSha, memoryAnywhereSystem, systemsFromRegistry } from "./systems.ts";

function fmt(i: { mean: number; ci95: [number, number] }): string {
  return `${i.mean.toFixed(3)} [${i.ci95[0].toFixed(3)}, ${i.ci95[1].toFixed(3)}]`;
}

export async function loadItems(split: "dev" | "test"): Promise<RetrievalItem[]> {
  const ids = new Set((JSON.parse(readFileSync(SPLIT_FILE, "utf8")) as Record<string, string[]>)[split]);
  return loadLme(await fetchLongMemEval())
    .filter((q) => ids.has(q.question_id))
    .map(toRetrievalItem);
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { suite: { type: "string", default: "R" }, system: { type: "string" }, split: { type: "string", default: "test" }, out: { type: "string" } },
  });
  if (positionals[0] !== "run" || !["R", "P", "W", "C"].includes(values.suite ?? "")) {
    console.error("usage: pnpm eval run --suite <R|P|W|C> [--system bm25,vector:<model>,memory-anywhere] [--split test|dev] [--out <file>]");
    return 1;
  }
  const split = values.split === "dev" ? "dev" : "test";
  const write = (result: unknown): void => {
    if (!values.out) return;
    writeFileSync(values.out, JSON.stringify({ ...(result as object), git_sha: gitSha(), policy_version: "P1", started_at: new Date().toISOString() }, null, 2) + "\n");
    console.log(`wrote ${values.out}`);
  };
  if (values.suite === "P") {
    const r = await runSuiteP();
    console.log(`Suite P server stage, n = ${r.n}`);
    for (const [k, g] of Object.entries(r.gates)) console.log(`  ${k}: ${g.stored}/${g.n} stored (95% upper bound ${(g.upper95 * 100).toFixed(1)}%) ${g.pass ? "PASS" : "FAIL"}`);
    for (const [k, v] of Object.entries(r.families)) console.log(`  ${k.padEnd(15)} n=${v.n} ${v.labels.padEnd(10)} as expected ${v.correct}/${v.n}`);
    write(r);
    return Object.values(r.gates).every((g) => g.pass) ? 0 : 1;
  }
  if (values.suite === "W" || values.suite === "C") {
    const modelFiles = process.env["MA_TEST_MODEL_DIR"] ?? join(import.meta.dirname, "..", "..", "spikes", "embed-bench", "out", "models", "onnx-community__embeddinggemma-300m-ONNX@5090578d9565");
    if (!existsSync(modelFiles)) throw new Error(`no model files at ${modelFiles}; set MA_TEST_MODEL_DIR`);
    if (values.suite === "C") {
      const r = await runSuiteC(modelFiles);
      console.log(`Suite C local: recall p50 ${r.recall_ms.p50} ms, p95 ${r.recall_ms.p95} ms (n=${r.n}) ${r.recall_pass ? "PASS" : "FAIL"}; session start ${r.session_start_chars} chars ${r.session_start_pass ? "PASS" : "FAIL"}`);
      write(r);
      return r.recall_pass && r.session_start_pass ? 0 : 1;
    }
    const embedder = await OnnxEmbedder.load(modelFiles, activeModel());
    const { result } = await runSuiteW(await buildCases(), embedder, split);
    await embedder.release();
    console.log(`Suite W (${split}), n = ${result.n}: ${result.gate.wrong_supersedes} wrong supersedes of ${result.gate.eligible} eligible (95% upper bound ${(result.gate.upper95 * 100).toFixed(1)}%) ${result.gate.pass ? "PASS" : "FAIL"}`);
    console.log(`  ops as expected ${result.accuracy.k}/${result.accuracy.n}`);
    for (const [exp, row] of Object.entries(result.confusion)) console.log(`  expected ${exp.padEnd(7)} → ${Object.entries(row).map(([o, n]) => `${o} ${n}`).join(", ")}`);
    write(result);
    return result.gate.pass ? 0 : 1;
  }
  const items = await loadItems(split);
  const bm25System: RankingSystem = { name: "bm25", rank: (docs, q) => bm25Rank(docs, q) };
  const full = !values.system || values.system.split(",").includes("memory-anywhere") ? memoryAnywhereSystem() : undefined;
  const systems = [bm25System, ...(await systemsFromRegistry(values.system)), ...(full ? [full] : [])].filter((s) => !values.system || values.system.split(",").includes(s.name));
  const dataset = `longmemeval-s-${split === "test" ? 200 : 100}`;
  const results: SuiteRResult[] = [];
  for (const s of systems) {
    process.stderr.write(`running ${s.name} on ${items.length} ${split} questions ...\n`);
    results.push(await runSuiteR(s, items, { dataset, split }));
  }
  const bm25 = results.find((r) => r.system === "bm25");
  for (const r of results) {
    if (bm25 && r !== bm25) r.comparisons.push(compare(r, bm25, "ndcg10"), compare(r, bm25, "r5"));
    // The M1 gate also needs the full system against vector-only.
    if (r.system === "memory-anywhere") for (const v of results.filter((x) => x.system.startsWith("vector:"))) r.comparisons.push(compare(r, v, "ndcg10"), compare(r, v, "r5"));
  }
  console.log(`Suite R, ${dataset} (${split}), answerable n = ${results[0]?.per_query.filter((p) => p.category !== "abstention").length ?? 0}, 95% bootstrap CIs (10,000 resamples, seed 1234)`);
  for (const r of results) {
    console.log(`\n${r.system}: nDCG@10 ${fmt(r.metrics.ndcg10)}  R@5 ${fmt(r.metrics.r5)}  (${(r.duration_ms / 1000).toFixed(1)} s)`);
    for (const [c, v] of Object.entries(r.per_category)) {
      if (v.abstained) console.log(`  ${c.padEnd(13)} n=${v.n}  returned nothing ${v.abstained.k}/${v.abstained.n}`);
      else if (v.ndcg10 && v.r5) console.log(`  ${c.padEnd(13)} n=${v.n}  nDCG@10 ${fmt(v.ndcg10)}  R@5 ${fmt(v.r5)}`);
    }
    for (const c of r.comparisons) console.log(`  vs ${c.vs} ${c.metric}: ${c.diff >= 0 ? "+" : ""}${c.diff.toFixed(3)} [${c.ci95[0].toFixed(3)}, ${c.ci95[1].toFixed(3)}]`);
  }
  if (values.out) {
    const sha = gitSha();
    writeFileSync(values.out, JSON.stringify(results.map((r) => ({ ...r, git_sha: sha, policy_version: "P1" })), null, 2) + "\n");
    console.log(`\nwrote ${values.out}`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
