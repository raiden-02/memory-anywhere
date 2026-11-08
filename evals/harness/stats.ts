// Statistics of evals.md §5: Wilson intervals, percentile bootstrap of a mean, and the paired
// bootstrap of a mean difference. Seeded (mulberry32, seed 1234), so results are reproducible.

export const RESAMPLES = 10_000;
export const SEED = 1234;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (sorted[lo] ?? NaN) + ((sorted[hi] ?? NaN) - (sorted[lo] ?? NaN)) * (i - lo);
}

export interface Interval {
  mean: number;
  ci95: [number, number];
}

/** Percentile bootstrap 95% CI of the mean. */
export function bootstrapMean(xs: number[], resamples = RESAMPLES, seed = SEED): Interval {
  const rand = mulberry32(seed);
  const n = xs.length;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)] ?? 0;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(xs), ci95: [percentile(means, 0.025), percentile(means, 0.975)] };
}

/** Paired bootstrap over items of the mean difference a - b. */
export function pairedBootstrap(a: number[], b: number[], resamples = RESAMPLES, seed = SEED): Interval {
  if (a.length !== b.length) throw new Error("paired samples must have the same length");
  return bootstrapMean(
    a.map((x, i) => x - (b[i] ?? NaN)),
    resamples,
    seed,
  );
}

/** Wilson score 95% interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.959964): { p: number; ci95: [number, number] } {
  if (n === 0) return { p: NaN, ci95: [NaN, NaN] };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}
