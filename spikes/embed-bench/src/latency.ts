// Query latency and process RSS for one candidate, in a clean process (ADR-0005 limits: p95
// <= 150 ms on the owner's PC, <= 400 ms on t4g.small, RSS <= 700 MB on t4g.small). CPU only.
//
//   node spikes/embed-bench/src/latency.ts <candidate id> <queries.json> [--store 10000]
//
// queries.json is a JSON array of query strings (the dev questions). Per query: embed it with
// the query prefix and score it against a store of L2-normalised vectors (brute-force dot
// product, as retrieval.md §2 step 3). Prints one JSON line.

import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { dot, Embedder, normalize } from "./embedder.ts";
import { CANDIDATES } from "./models.ts";

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { store: { type: "string", default: "10000" } } });
const [id, file] = positionals;
const c = CANDIDATES.find((x) => x.id === id);
if (!c || !file) {
  console.error("usage: latency.ts <candidate id> <queries.json> [--store 10000]");
  process.exit(2);
}
const queries = JSON.parse(readFileSync(file, "utf8")) as string[];
const rssBefore = process.memoryUsage().rss;
const e = await Embedder.load(c, { device: "cpu" });
const store = Array.from({ length: Number(values.store) }, () => normalize(Float32Array.from({ length: c.dims }, () => Math.random() - 0.5)));
await e.embed(["warm up"], "query");
const times: number[] = [];
let peakRss = 0;
for (const q of queries) {
  const t0 = performance.now();
  const [v] = await e.embed([q], "query");
  let best = -1;
  for (const s of store) best = Math.max(best, dot(v ?? new Float32Array(), s));
  times.push(performance.now() - t0);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  void best;
}
console.log(
  JSON.stringify({
    candidate: c.id,
    queries: queries.length,
    store_vectors: store.length,
    p50_ms: Number(pct(times, 0.5).toFixed(1)),
    p95_ms: Number(pct(times, 0.95).toFixed(1)),
    max_ms: Number(Math.max(...times).toFixed(1)),
    rss_baseline_mb: Math.round(rssBefore / 2 ** 20),
    rss_peak_mb: Math.round(peakRss / 2 ** 20),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: cpus().length,
    cpu_model: cpus()[0]?.model ?? "",
    total_mem_mb: Math.round(totalmem() / 2 ** 20),
  }),
);
await e.release();
