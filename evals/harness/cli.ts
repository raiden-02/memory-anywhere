// pnpm eval run --suite R [--system bm25,vector:<model>] [--split test|dev] [--out <file>]
// (evals.md §9). Needs no API keys. With no --system, runs every M0 baseline that is available.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { bm25Rank } from "../adapters/bm25.ts";
import { fetchLongMemEval } from "../datasets/public/fetch-longmemeval.ts";
import { SPLIT_FILE } from "../datasets/public/make-subsets.ts";
import { loadLme, toRetrievalItem, type RetrievalItem } from "./lme.ts";
import { compare, runSuiteR, type RankingSystem, type SuiteRResult } from "./suite-r.ts";
import { gitSha, systemsFromRegistry } from "./systems.ts";

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
  if (positionals[0] !== "run" || values.suite !== "R") {
    console.error("usage: pnpm eval run --suite R [--system bm25,vector:<model>] [--split test|dev] [--out <file>]");
    return 1;
  }
  const split = values.split === "dev" ? "dev" : "test";
  const items = await loadItems(split);
  const bm25System: RankingSystem = { name: "bm25", rank: (docs, q) => bm25Rank(docs, q) };
  const systems = [bm25System, ...(await systemsFromRegistry(values.system))].filter((s) => !values.system || values.system.split(",").includes(s.name));
  const dataset = `longmemeval-s-${split === "test" ? 200 : 100}`;
  const results: SuiteRResult[] = [];
  for (const s of systems) {
    process.stderr.write(`running ${s.name} on ${items.length} ${split} questions ...\n`);
    results.push(await runSuiteR(s, items, { dataset, split }));
  }
  const bm25 = results.find((r) => r.system === "bm25");
  for (const r of results) {
    if (bm25 && r !== bm25) r.comparisons.push(compare(r, bm25, "ndcg10"), compare(r, bm25, "r5"));
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
