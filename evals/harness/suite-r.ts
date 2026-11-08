// Suite R on the LongMemEval-S subsets (evals.md §3.2, §5): ranks each question's haystack with
// a system, scores nDCG@10 and R@5 by id, and reports means with bootstrap 95% CIs, per category,
// and paired comparisons. Abstention questions have no relevant documents; for systems without an
// abstention threshold they are reported separately as "returned nothing" counts.

import { ndcgAt, recallAt } from "./metrics.ts";
import { CATEGORIES, type Category, type Doc, type RetrievalItem } from "./lme.ts";
import { bootstrapMean, pairedBootstrap, wilson, type Interval } from "./stats.ts";

export interface RankingSystem {
  name: string;
  /** Ranked document ids, best first. `item` identifies the question (for cached embeddings). */
  rank(docs: Doc[], query: string, item?: RetrievalItem): Promise<string[]> | string[];
}

export interface PerQuery {
  qid: string;
  category: Category;
  ndcg10: number;
  r5: number;
  returned: number;
}

export interface SuiteRResult {
  suite: "R";
  system: string;
  dataset: string;
  split: string;
  labels: "public";
  n: number;
  runs: 1;
  metrics: { ndcg10: Interval; r5: Interval };
  per_category: Record<string, { n: number; ndcg10?: Interval; r5?: Interval; abstained?: { k: number; n: number; ci95: [number, number] } }>;
  comparisons: { vs: string; metric: "ndcg10" | "r5"; diff: number; ci95: [number, number] }[];
  per_query: PerQuery[];
  eval_spend_usd: 0;
  started_at: string;
  duration_ms: number;
}

export async function runSuiteR(system: RankingSystem, items: RetrievalItem[], meta: { dataset: string; split: string }): Promise<SuiteRResult> {
  const started = Date.now();
  const per: PerQuery[] = [];
  for (const it of items) {
    const ranked = await system.rank(it.docs, it.query, it);
    const rel = new Set(it.relevant);
    per.push({ qid: it.qid, category: it.category, ndcg10: ndcgAt(ranked, rel), r5: recallAt(ranked, rel), returned: ranked.length });
  }
  const answerable = per.filter((p) => p.category !== "abstention");
  const perCategory: SuiteRResult["per_category"] = {};
  for (const c of CATEGORIES) {
    const rows = per.filter((p) => p.category === c);
    if (rows.length === 0) continue;
    if (c === "abstention") {
      const k = rows.filter((r) => r.returned === 0).length;
      perCategory[c] = { n: rows.length, abstained: { k, n: rows.length, ci95: wilson(k, rows.length).ci95 } };
    } else {
      perCategory[c] = { n: rows.length, ndcg10: bootstrapMean(rows.map((r) => r.ndcg10)), r5: bootstrapMean(rows.map((r) => r.r5)) };
    }
  }
  return {
    suite: "R",
    system: system.name,
    dataset: meta.dataset,
    split: meta.split,
    labels: "public",
    n: per.length,
    runs: 1,
    metrics: { ndcg10: bootstrapMean(answerable.map((p) => p.ndcg10)), r5: bootstrapMean(answerable.map((p) => p.r5)) },
    per_category: perCategory,
    comparisons: [],
    per_query: per,
    eval_spend_usd: 0,
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
  };
}

/** Paired comparison of a against b over the answerable questions both scored. */
export function compare(a: SuiteRResult, b: SuiteRResult, metric: "ndcg10" | "r5"): { vs: string; metric: typeof metric; diff: number; ci95: [number, number] } {
  const bBy = new Map(b.per_query.map((p) => [p.qid, p]));
  const pairs = a.per_query.filter((p) => p.category !== "abstention" && bBy.has(p.qid));
  const r = pairedBootstrap(
    pairs.map((p) => p[metric]),
    pairs.map((p) => bBy.get(p.qid)?.[metric] ?? NaN),
  );
  return { vs: b.system, metric, diff: r.mean, ci95: r.ci95 };
}
