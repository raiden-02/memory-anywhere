// Suite W cases from public data (evals.md §3.1): MemoryAgentBench FactConsolidation (MIT), whose
// fact lists restate earlier facts with a new object. Labels follow mechanically from the text,
// with no model and no author judgement. Each fact is parsed as subject · relation · object:
//
//   subject   the leading run of capitalised words        "Thomas Kyd"
//   relation  the run of lowercase words that follows      "was born in the city of"
//   object    the rest, starting with a capital or digit   "London"
//
// Pairs of facts about the same subject become cases:
//
//   same relation, new object   "…born in the city of London" → "…born in the city of Paris"   → `update`
//   different relation          "…born in the city of …"      → "…is a citizen of …"           → `new`
//                               (supersede-eligible: a system that supersedes here is wrong)
//   the same fact twice                                                                        → `dup`
//
// Facts that do not parse this way ("The director of X is Y", "…plays baseball") give no case.
// Cases are split dev/test by a hash of the case, so the split is stable across runs.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { seededPrng } from "@memory-anywhere/contracts/ids";
import { fetchMab, MAB_DIR } from "../public/fetch-mab.ts";

export type WOp = "dup" | "update" | "correction" | "historical" | "contested" | "new" | "observation" | "review" | "reject";

export interface WCase {
  readonly case_id: string;
  readonly category: "update" | "new" | "dup";
  readonly split: "dev" | "test";
  readonly source: "memoryagentbench/factconsolidation";
  readonly prior: { readonly entity: string; readonly content: string }[];
  readonly input: { readonly entity: string; readonly content: string };
  readonly expected: { readonly op: WOp };
  /** Expected op is not a supersede, but the prior has the same subject, so a supersede was possible. */
  readonly supersede_eligible: boolean;
}

/** A fact as subject, relation and object: "Thomas Kyd" · "was born in the city of" · "London". */
export interface Triple {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
}

const CAPITAL = /^[\p{Lu}\p{N}]/u;
const LOWER = /^\p{Ll}+$/u;

export function parseFact(fact: string): Triple | undefined {
  const w = fact.replace(/\.$/u, "").split(/\s+/u);
  let i = 0;
  while (i < w.length && CAPITAL.test(w[i] ?? "")) i++;
  const subject = w.slice(0, i);
  let j = i;
  while (j < w.length && LOWER.test(w[j] ?? "")) j++;
  const relation = w.slice(i, j);
  const object = w.slice(j);
  if (subject.length === 0 || relation.length < 2 || object.length === 0 || !CAPITAL.test(object[0] ?? "")) return undefined;
  if (subject[0] === "The") return undefined; // "The director of X is Y": the subject is not at the start
  return { subject: subject.join(" "), relation: relation.join(" "), object: object.join(" ") };
}

/** The numbered facts of the longest FactConsolidation context. */
export async function loadFacts(): Promise<string[]> {
  await fetchMab();
  const rows = (await parquetReadObjects({ file: await asyncBufferFromFile(join(MAB_DIR, "Conflict_Resolution-00000-of-00001.parquet")) })) as { context: string }[];
  const context = rows.map((r) => r.context).sort((a, b) => b.length - a.length)[0] ?? "";
  return [...context.matchAll(/^\d+\. (.+)$/gmu)].map((m) => (m[1] ?? "").trim()).filter((f) => f.endsWith("."));
}

export async function buildCases(perCategory = { update: 250, new: 300, dup: 50 }): Promise<WCase[]> {
  const facts = await loadFacts();
  const bySubject = new Map<string, { i: number; t: Triple }[]>();
  facts.forEach((f, i) => {
    const t = parseFact(f);
    if (t) bySubject.set(t.subject, [...(bySubject.get(t.subject) ?? []), { i, t }]);
  });

  const update: [number, number, string][] = [];
  const fresh: [number, number, string][] = [];
  const dup: [number, number, string][] = [];
  for (const [subject, list] of bySubject) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const x = list[a] as { i: number; t: Triple };
        const y = list[b] as { i: number; t: Triple };
        if (x.t.relation !== y.t.relation) fresh.push([x.i, y.i, subject]);
        else if (x.t.object === y.t.object) dup.push([x.i, y.i, subject]);
        else update.push([x.i, y.i, subject]);
      }
    }
  }

  const rnd = seededPrng(31);
  const sample = <T>(xs: T[], n: number): T[] => {
    const copy = [...xs];
    for (let k = copy.length - 1; k > 0; k--) {
      const r = Math.floor(rnd() * (k + 1));
      [copy[k], copy[r]] = [copy[r] as T, copy[k] as T];
    }
    return copy.slice(0, n);
  };
  const make = (category: WCase["category"], [i, j, entity]: [number, number, string]): WCase => {
    const id = createHash("sha256").update(`${category}|${facts[i]}|${facts[j]}`).digest("hex").slice(0, 12);
    return {
      case_id: `w_${id}`,
      category,
      split: Number.parseInt(id.slice(0, 2), 16) % 2 === 0 ? "dev" : "test",
      source: "memoryagentbench/factconsolidation",
      prior: [{ entity, content: facts[i] as string }],
      input: { entity, content: facts[j] as string },
      expected: { op: category },
      supersede_eligible: category !== "update",
    };
  };
  return [
    ...sample(update, perCategory.update).map((p) => make("update", p)),
    ...sample(fresh, perCategory.new).map((p) => make("new", p)),
    ...sample(dup, perCategory.dup).map((p) => make("dup", p)),
  ];
}
