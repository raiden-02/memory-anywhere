// M0 Q20 decision rule (m0-spike.md §4, deployment-aws.md §11): the region with
// the lowest median TLS handshake time wins; ties go to us-east-1.
//
// A "tie" is defined as in ADR-0005 (owner decision, ADR-0112): a region ties
// with the fastest one when the 95% percentile-bootstrap CI of the difference
// in medians (10,000 resamples, seed 1234, evals.md §5) includes 0.

export interface RegionSamples {
  region: string;
  samplesMs: readonly number[];
}

export interface RegionSummary {
  region: string;
  n: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
}

export interface Comparison {
  region: string;
  /** median(region) − median(fastest), ms. */
  medianDiffMs: number;
  ci95Ms: [number, number];
  tiedWithFastest: boolean;
}

export interface Decision {
  fastest: string;
  chosen: string;
  comparisons: Comparison[];
}

export const TIE_BREAK_REGION = "us-east-1";
export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 1234;

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Linear-interpolated quantile (type 7, the common default). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("quantile of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function summarize({ region, samplesMs }: RegionSamples): RegionSummary {
  return {
    region,
    n: samplesMs.length,
    medianMs: round1(quantile(samplesMs, 0.5)),
    p10Ms: round1(quantile(samplesMs, 0.1)),
    p90Ms: round1(quantile(samplesMs, 0.9)),
    minMs: round1(Math.min(...samplesMs)),
    maxMs: round1(Math.max(...samplesMs)),
  };
}

/** mulberry32: small, seedable, good enough for resampling indices. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resample(values: readonly number[], rnd: () => number): number[] {
  return values.map(() => values[Math.floor(rnd() * values.length)] as number);
}

/** 95% percentile-bootstrap CI of median(a) − median(b) (independent samples). */
export function medianDiffCi(
  a: readonly number[],
  b: readonly number[],
  resamples = BOOTSTRAP_RESAMPLES,
  seed = BOOTSTRAP_SEED,
): [number, number] {
  const rnd = prng(seed);
  const diffs: number[] = [];
  for (let i = 0; i < resamples; i++) {
    diffs.push(quantile(resample(a, rnd), 0.5) - quantile(resample(b, rnd), 0.5));
  }
  return [quantile(diffs, 0.025), quantile(diffs, 0.975)];
}

export function decideRegion(series: readonly RegionSamples[]): Decision {
  if (series.length === 0) throw new Error("no regions measured");
  const medians = series.map((s) => ({ s, median: quantile(s.samplesMs, 0.5) }));
  medians.sort((x, y) => x.median - y.median);
  const fastest = medians[0] as (typeof medians)[number];

  const comparisons: Comparison[] = medians.map(({ s, median }) => {
    if (s === fastest.s) {
      return { region: s.region, medianDiffMs: 0, ci95Ms: [0, 0], tiedWithFastest: true };
    }
    const [lo, hi] = medianDiffCi(s.samplesMs, fastest.s.samplesMs);
    return {
      region: s.region,
      medianDiffMs: round2(median - fastest.median),
      ci95Ms: [round2(lo), round2(hi)],
      tiedWithFastest: lo <= 0 && 0 <= hi,
    };
  });

  const tied = comparisons.filter((c) => c.tiedWithFastest).map((c) => c.region);
  return {
    fastest: fastest.s.region,
    chosen: tied.includes(TIE_BREAK_REGION) ? TIE_BREAK_REGION : fastest.s.region,
    comparisons,
  };
}
