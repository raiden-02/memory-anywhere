// Quick throughput probe: embed the first N dev rounds with each candidate on a device.
//   node spikes/embed-bench/src/throughput.ts [cpu|dml] [N]
import { loadItems } from "../../../evals/harness/cli.ts";
import { Embedder } from "./embedder.ts";
import { CANDIDATES } from "./models.ts";

const device = process.argv[2] === "dml" ? "dml" : "cpu";
const n = Number(process.argv[3] ?? 256);
const items = await loadItems("dev");
const docs = items.flatMap((i) => i.docs).slice(0, n);
for (const c of CANDIDATES) {
  const e = await Embedder.load(c, { device });
  const tokens = docs.reduce((s, d) => s + e.tokenize(c.docPrefix + d.text).length, 0);
  const sorted = [...docs].sort((a, b) => a.text.length - b.text.length);
  const t0 = performance.now();
  for (let i = 0; i < sorted.length; i += 32) await e.embed(sorted.slice(i, i + 32).map((d) => d.text), "doc");
  const s = (performance.now() - t0) / 1000;
  console.log(`${c.id.padEnd(24)} ${device}: ${n} docs, ${tokens} tokens in ${s.toFixed(1)} s = ${(tokens / s).toFixed(0)} tok/s`);
  await e.release();
}
