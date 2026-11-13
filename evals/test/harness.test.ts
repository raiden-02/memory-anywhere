import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bm25Rank, ftsQuery } from "../adapters/bm25.ts";
import { allocate, shuffle } from "../datasets/public/make-subsets.ts";
import { categoryOf, rounds, toRetrievalItem } from "../harness/lme.ts";
import { ndcgAt, recallAt } from "../harness/metrics.ts";
import { bootstrapMean, mulberry32, pairedBootstrap, wilson } from "../harness/stats.ts";
import { judge, loadCases, ROOT, summarize, type AttackCase } from "../harness/suite-s.ts";

describe("metrics", () => {
  it("scores a perfect and a missed ranking", () => {
    const rel = new Set(["a", "b"]);
    expect(ndcgAt(["a", "b", "c"], rel)).toBeCloseTo(1);
    expect(ndcgAt(["c", "d"], rel)).toBe(0);
    expect(recallAt(["a", "x", "y", "z", "w", "b"], rel, 5)).toBe(0.5);
  });

  it("discounts by rank", () => {
    expect(ndcgAt(["x", "a"], new Set(["a"]))).toBeCloseTo(1 / Math.log2(3));
  });

  it("is undefined (NaN) when nothing is relevant", () => {
    expect(ndcgAt(["a"], new Set())).toBeNaN();
  });
});

describe("statistics", () => {
  it("is reproducible for a fixed seed", () => {
    expect(bootstrapMean([0, 1, 1, 0, 1], 500).ci95).toEqual(bootstrapMean([0, 1, 1, 0, 1], 500).ci95);
  });

  it("brackets the mean", () => {
    const r = bootstrapMean([0.2, 0.4, 0.6, 0.8, 1.0], 2000);
    expect(r.mean).toBeCloseTo(0.6);
    expect(r.ci95[0]).toBeLessThan(0.6);
    expect(r.ci95[1]).toBeGreaterThan(0.6);
  });

  it("gives a paired difference whose CI excludes 0 when one system is always better", () => {
    const a = Array.from({ length: 50 }, (_, i) => 0.5 + (i % 5) * 0.1);
    const r = pairedBootstrap(a, a.map((x) => x - 0.1), 2000);
    expect(r.mean).toBeCloseTo(0.1);
    expect(r.ci95[0]).toBeGreaterThan(0);
  });

  it("matches the textbook Wilson interval", () => {
    const w = wilson(0, 100);
    expect(w.ci95[0]).toBe(0);
    expect(w.ci95[1]).toBeCloseTo(0.037, 3);
  });

  it("generates numbers in [0, 1)", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("LongMemEval mapping", () => {
  it("maps question types to the five categories", () => {
    expect(categoryOf({ question_id: "q1", question_type: "single-session-preference" })).toBe("single");
    expect(categoryOf({ question_id: "q2", question_type: "knowledge-update" })).toBe("update");
    expect(categoryOf({ question_id: "q3_abs", question_type: "temporal-reasoning" })).toBe("abstention");
  });

  it("splits a session into rounds starting at each user turn", () => {
    const r = rounds("s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "I moved to Denver", has_answer: true },
      { role: "assistant", content: "nice" },
    ]);
    expect(r.map((x) => x.doc.id)).toEqual(["s1#0", "s1#1"]);
    expect(r.map((x) => x.relevant)).toEqual([false, true]);
  });

  it("drops relevance for abstention questions", () => {
    const item = toRetrievalItem({
      question_id: "q_abs",
      question_type: "single-session-user",
      question: "where?",
      question_date: "",
      haystack_session_ids: ["s1"],
      haystack_dates: [""],
      haystack_sessions: [[{ role: "user", content: "x", has_answer: true }]],
    });
    expect(item.relevant).toEqual([]);
  });
});

describe("subsets", () => {
  it("allocates proportionally and exactly", () => {
    const a = allocate({ single: 150, update: 72, temporal: 127, "multi-session": 121, abstention: 30 }, 200);
    expect(Object.values(a).reduce((s, x) => s + x, 0)).toBe(200);
    expect(a.single).toBe(60);
  });

  it("shuffles deterministically", () => {
    expect(shuffle([1, 2, 3, 4, 5], mulberry32(1234))).toEqual(shuffle([1, 2, 3, 4, 5], mulberry32(1234)));
  });
});

describe("BM25 baseline", () => {
  it("builds the retrieval.md query: lowercased, stopwords out, quoted, OR-joined", () => {
    expect(ftsQuery("Where do I live NOW?")).toBe('"live"');
    expect(ftsQuery('Alex "quoted"')).toBe('"alex" OR "quoted"');
  });

  it("ranks the matching round first, with porter stemming", () => {
    const docs = [
      { id: "a", text: "user: I like tea" },
      { id: "b", text: "user: I started running every morning" },
    ];
    expect(bm25Rank(docs, "how often do I run?")[0]).toBe("b");
  });
});

describe("suite S", () => {
  const base = { family: "S-OAUTH", channel: "/mcp", setup: "s", payload: "p", success_condition: "c" } as const;
  const named = (id: string, name: string): AttackCase => ({ ...base, id, runner: { kind: "test", file: "a.test.ts", name } });

  it("passes a case only on a passing run of the very test it names", () => {
    const cases = [named("S-OAUTH-01", "proves it"), named("S-OAUTH-02", "fails"), named("S-OAUTH-03", "renamed"), { ...base, id: "S-OAUTH-04", runner: { kind: "model", goal: "store", task: "t", files: {}, canary: "zzzz" } } as AttackCase];
    const status = new Map([["a.test.ts::proves it", "passed"], ["a.test.ts::fails", "failed"], ["b.test.ts::renamed", "passed"]]);
    expect(judge(cases, status).map((r) => r.verdict)).toEqual(["pass", "fail", "missing", "not_run"]);
    const s = summarize(cases, judge(cases, status));
    expect(s.gate.local_deterministic_pass).toBe(false);
    expect(s.families["S-OAUTH"]).toMatchObject({ cases: 4, pass: 1, fail: 1, missing: 1, not_run: 1 });
  });

  it("the case file parses, its ids are unique and in their family, and every test it names exists", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      if (c.runner.kind !== "test") continue;
      const source = readFileSync(join(ROOT, c.runner.file), "utf8");
      expect(source.includes(JSON.stringify(c.runner.name)) || source.includes(`"${c.runner.name}"`), `${c.id}: ${c.runner.name}`).toBe(true);
    }
  });
});
