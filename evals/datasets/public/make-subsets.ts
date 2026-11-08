// Seeded, stratified, disjoint LongMemEval-S subsets for suite R (evals.md §3.2):
// 100 dev questions (every choice: Q14's model, abstain_cosine) and 200 test questions
// (reported baselines and the M1 gate only). Proportional allocation per category
// (largest remainder), Fisher-Yates with mulberry32(1234).
//
//   node evals/datasets/public/make-subsets.ts   -> evals/datasets/public/longmemeval-s/split.json

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, categoryOf, loadLme, type Category } from "../../harness/lme.ts";
import { mulberry32, SEED } from "../../harness/stats.ts";
import { fetchLongMemEval, LME_REVISION, LME_SHA256 } from "./fetch-longmemeval.ts";

export const SPLIT_FILE = join(import.meta.dirname, "longmemeval-s", "split.json");

export function allocate(counts: Record<Category, number>, total: number): Record<Category, number> {
  const all = CATEGORIES.reduce((s, c) => s + counts[c], 0);
  const raw = CATEGORIES.map((c) => ({ c, exact: (counts[c] * total) / all }));
  const out = Object.fromEntries(raw.map((r) => [r.c, Math.floor(r.exact)])) as Record<Category, number>;
  let left = total - CATEGORIES.reduce((s, c) => s + out[c], 0);
  for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left-- <= 0) break;
    out[r.c]++;
  }
  return out;
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

async function main(): Promise<void> {
  const questions = loadLme(await fetchLongMemEval());
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, [] as string[]])) as Record<Category, string[]>;
  for (const q of questions) byCat[categoryOf(q)].push(q.question_id);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, byCat[c].length])) as Record<Category, number>;
  const devN = allocate(counts, 100);
  const testN = allocate(counts, 200);
  const rand = mulberry32(SEED);
  const dev: string[] = [];
  const test: string[] = [];
  for (const c of CATEGORIES) {
    const ids = shuffle([...byCat[c]].sort(), rand);
    dev.push(...ids.slice(0, devN[c]));
    test.push(...ids.slice(devN[c], devN[c] + testN[c]));
  }
  const split = {
    dataset: "LongMemEval-S (cleaned)",
    source: `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned@${LME_REVISION} longmemeval_s_cleaned.json`,
    sha256: LME_SHA256,
    licence: "MIT",
    seed: SEED,
    method: "per-category Fisher-Yates (mulberry32) over sorted ids; proportional allocation, largest remainder; dev and test disjoint",
    category_map: {
      "single-session-user | single-session-assistant | single-session-preference": "single",
      "knowledge-update": "update",
      "temporal-reasoning": "temporal",
      "multi-session": "multi-session",
      "question_id ending in _abs": "abstention",
    },
    documents: "rounds: one user turn plus the assistant turns that follow it; a round is relevant if any of its turns has has_answer",
    population: counts,
    dev_per_category: devN,
    test_per_category: testN,
    dev: dev.sort(),
    test: test.sort(),
  };
  mkdirSync(join(import.meta.dirname, "longmemeval-s"), { recursive: true });
  writeFileSync(SPLIT_FILE, JSON.stringify(split, null, 2) + "\n");
  console.log(`dev ${dev.length}, test ${test.length}`, devN, testN);
}

if (import.meta.main) await main();
