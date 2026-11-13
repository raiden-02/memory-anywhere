// Suite S (evals.md §3.5): the attack cases in evals/datasets/s/attacks.jsonl. Each deterministic
// case names the test that proves it; the runner runs those tests once through vitest's JSON
// reporter and a case passes only if its named test ran and passed. One test may prove several
// cases (each case says what its test checks), and a case never passes on a test it does not name.
//
//   attacks.jsonl ──► the tests the local cases name ──► vitest --reporter=json ──► per case: pass / fail / missing
//                └─► model-driven and eval-stack cases: reported as "not run here" until their runners run
//
// Success is always judged on server state or responses, never on a model's text (the tests check
// stored outcomes, status codes, headers and audit rows).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";

export const ROOT = join(import.meta.dirname, "..", "..");
export const ATTACKS_FILE = join(ROOT, "evals", "datasets", "s", "attacks.jsonl");

export const FAMILIES = ["S-POI", "S-EXF", "S-OAUTH", "S-WEB", "S-AGENT", "S-LOCAL", "S-AWS", "S-PURGE", "S-DOW"] as const;
/** Minimum case counts per family for M2 (evals.md §3.5). */
export const MINIMUM: Readonly<Record<(typeof FAMILIES)[number], number>> = {
  "S-POI": 100, "S-EXF": 50, "S-OAUTH": 45, "S-WEB": 30, "S-AGENT": 20, "S-LOCAL": 10, "S-AWS": 9, "S-PURGE": 20, "S-DOW": 5,
};

const Case = z.strictObject({
  id: z.string().regex(/^S-[A-Z]+-\d{2,3}$/u),
  family: z.enum(FAMILIES),
  channel: z.string().min(1),
  setup: z.string().min(1),
  payload: z.string().min(1),
  success_condition: z.string().min(1),
  /** Where the case runs: a named test here, a model-driven run, or an eval stack. */
  runner: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("test"), file: z.string().min(1), name: z.string().min(1) }),
    z.strictObject({ kind: z.literal("model") }),
    z.strictObject({ kind: z.literal("eval-stack") }),
  ]),
});
export type AttackCase = z.infer<typeof Case>;

export function loadCases(file = ATTACKS_FILE): AttackCase[] {
  const cases = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    const parsed = Case.safeParse(JSON.parse(l));
    if (!parsed.success) throw new Error(`attacks.jsonl line ${i + 1}: ${parsed.error.message}`);
    return parsed.data;
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    if (!c.id.startsWith(`${c.family}-`)) throw new Error(`${c.id} is not in family ${c.family}`);
    ids.add(c.id);
  }
  return cases;
}

export type Verdict = "pass" | "fail" | "missing" | "not_run";

export interface CaseResult {
  readonly id: string;
  readonly family: string;
  readonly verdict: Verdict;
  /** The test that decided it, or why it did not run. */
  readonly evidence: string;
}

interface VitestJson {
  testResults: { name: string; assertionResults: { title: string; status: string }[] }[];
}

/** Runs the named test files once and returns each test's status by "file::title". */
function runTests(files: readonly string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ma suite s "));
  try {
    const out = join(dir, "vitest.json");
    const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, ...files], {
      cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
    });
    if (r.error) throw r.error;
    const json = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
    const status = new Map<string, string>();
    for (const t of json.testResults) {
      const file = relative(ROOT, t.name).replaceAll("\\", "/");
      for (const a of t.assertionResults) status.set(`${file}::${a.title}`, a.status);
    }
    return status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function judge(cases: readonly AttackCase[], status: ReadonlyMap<string, string>): CaseResult[] {
  return cases.map((c) => {
    if (c.runner.kind !== "test") return { id: c.id, family: c.family, verdict: "not_run", evidence: c.runner.kind === "model" ? "model-driven (Claude Code headless)" : "needs an eval stack" };
    const key = `${c.runner.file}::${c.runner.name}`;
    const s = status.get(key);
    return { id: c.id, family: c.family, verdict: s === undefined ? "missing" : s === "passed" ? "pass" : "fail", evidence: key };
  });
}

export interface SuiteSResult {
  readonly suite: "S";
  readonly n: number;
  readonly families: Record<string, { cases: number; minimum: number; pass: number; fail: number; missing: number; not_run: number }>;
  /** Every case that ran here passed, none is missing, and every family has its minimum count. */
  readonly gate: { local_deterministic_pass: boolean; counts_met: boolean };
  readonly cases: CaseResult[];
}

export function summarize(cases: readonly AttackCase[], results: readonly CaseResult[]): SuiteSResult {
  const families: SuiteSResult["families"] = {};
  for (const f of FAMILIES) {
    const rs = results.filter((r) => r.family === f);
    families[f] = {
      cases: cases.filter((c) => c.family === f).length, minimum: MINIMUM[f],
      pass: rs.filter((r) => r.verdict === "pass").length, fail: rs.filter((r) => r.verdict === "fail").length,
      missing: rs.filter((r) => r.verdict === "missing").length, not_run: rs.filter((r) => r.verdict === "not_run").length,
    };
  }
  return {
    suite: "S",
    n: cases.length,
    families,
    gate: {
      local_deterministic_pass: results.every((r) => r.verdict === "pass" || r.verdict === "not_run"),
      counts_met: FAMILIES.every((f) => (families[f]?.cases ?? 0) >= MINIMUM[f]),
    },
    cases: [...results],
  };
}

export function runSuiteS(file = ATTACKS_FILE): SuiteSResult {
  const cases = loadCases(file);
  const files = [...new Set(cases.flatMap((c) => (c.runner.kind === "test" ? [c.runner.file] : [])))];
  const status = files.length > 0 ? runTests(files) : new Map<string, string>();
  return summarize(cases, judge(cases, status));
}
