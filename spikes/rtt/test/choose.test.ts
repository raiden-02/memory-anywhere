import { describe, expect, it } from "vitest";
import { decideRegion, medianDiffCi, quantile } from "../src/choose.ts";

// Deterministic jitter so tests do not depend on Math.random.
const series = (base: number, n = 50, spread = 2): number[] =>
  Array.from({ length: n }, (_, i) => base + ((i * 37) % 100) / (100 / spread));

describe("quantile", () => {
  it("interpolates linearly", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
    expect(() => quantile([], 0.5)).toThrow();
  });
});

describe("medianDiffCi", () => {
  it("is reproducible for a fixed seed", () => {
    expect(medianDiffCi(series(10), series(12), 2000)).toEqual(medianDiffCi(series(10), series(12), 2000));
  });

  it("excludes 0 for clearly different samples and includes it for equal ones", () => {
    const [lo] = medianDiffCi(series(150), series(90), 2000);
    expect(lo).toBeGreaterThan(0);
    const [a, b] = medianDiffCi(series(90), series(90), 2000);
    expect(a).toBeLessThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  });
});

describe("decideRegion", () => {
  it("picks the clearly fastest region", () => {
    const d = decideRegion([
      { region: "us-east-1", samplesMs: series(120) },
      { region: "us-east-2", samplesMs: series(90) },
      { region: "us-west-2", samplesMs: series(150) },
    ]);
    expect(d).toMatchObject({ fastest: "us-east-2", chosen: "us-east-2" });
    expect(d.comparisons.find((c) => c.region === "us-east-1")?.tiedWithFastest).toBe(false);
  });

  it("gives a statistical tie to us-east-1 even when it is a hair slower", () => {
    const d = decideRegion([
      { region: "us-east-1", samplesMs: series(90.3, 50, 4) },
      { region: "us-east-2", samplesMs: series(90.0, 50, 4) },
      { region: "us-west-2", samplesMs: series(150) },
    ]);
    expect(d.fastest).toBe("us-east-2");
    expect(d.chosen).toBe("us-east-1");
  });

  it("does not give the tie-break to us-east-1 when only other regions tie", () => {
    const d = decideRegion([
      { region: "us-east-1", samplesMs: series(150) },
      { region: "us-east-2", samplesMs: series(90.1, 50, 4) },
      { region: "us-west-2", samplesMs: series(90.0, 50, 4) },
    ]);
    expect(d.chosen).toBe("us-west-2");
  });
});
