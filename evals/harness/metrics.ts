// Retrieval metrics by id (evals.md §1.3): binary-relevance nDCG@k and recall@k.

export function ndcgAt(ranked: string[], relevant: Set<string>, k = 10): number {
  if (relevant.size === 0) return NaN;
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

export function recallAt(ranked: string[], relevant: Set<string>, k = 5): number {
  if (relevant.size === 0) return NaN;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}
