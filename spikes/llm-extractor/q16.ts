// M0 Q16: extractor quality of the pinned model on 50 synthetic prompts, with no API key:
// Claude Code headless on the owner's subscription (evals.md §8.3), the memory-policy.md §6.12
// prompt byte for byte, 10 prompts per call, 3 runs. Author-labelled: reported, never a gate.
//
//   node spikes/llm-extractor/q16.ts [--model claude-haiku-5-5] [--runs 3] [--out file.json]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { wilson } from "../../evals/harness/stats.ts";

interface Prompt {
  id: string;
  text: string;
  expect: string[][];
  secret?: string[];
}
interface Item {
  content: string;
  kind: string;
  span: string;
  prompt_id: string;
  attribute: string | null;
  entity: string | null;
}

const HERE = import.meta.dirname;
const POLICY = readFileSync(join(HERE, "..", "..", "docs", "spec", "memory-policy.md"), "utf8").replace(/\r\n/g, "\n");

export function extractorPrompt(prompts: { id: string; text: string }[]): string {
  const m = /```text id=extractor-prompt\n([\s\S]*?)\n```/.exec(POLICY);
  if (!m?.[1]) throw new Error("extractor prompt not found in memory-policy.md §6.12");
  return m[1].replace("{prompts}", JSON.stringify(prompts));
}

function runClaude(model: string, prompt: string, cwd: string): { items: Item[]; raw: string; ok: boolean } {
  const out = execFileSync(
    "claude",
    [
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      "You are a server-side extraction function. Reply with the JSON the instructions ask for and nothing else.",
    ],
    // claude is a native executable (claude.exe on Windows), so no shell: arguments with spaces stay whole.
    { input: prompt, encoding: "utf8", cwd, maxBuffer: 16 * 2 ** 20 },
  );
  const result = (JSON.parse(out) as { result?: string }).result ?? "";
  const json = /\{[\s\S]*\}/.exec(result)?.[0] ?? "";
  try {
    const parsed = JSON.parse(json) as { items?: Item[] };
    return { items: Array.isArray(parsed.items) ? parsed.items : [], raw: result, ok: Array.isArray(parsed.items) && json.trim() === result.trim() };
  } catch {
    return { items: [], raw: result, ok: false };
  }
}

function matches(item: Item, keywords: string[]): boolean {
  const c = item.content.toLowerCase();
  return keywords.every((k) => c.includes(k));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { model: { type: "string", default: "claude-haiku-5-5" }, runs: { type: "string", default: "3" }, out: { type: "string" } } });
  const prompts = (JSON.parse(readFileSync(join(HERE, "prompts.json"), "utf8")) as { prompts: Prompt[] }).prompts;
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const cwd = mkdtempSync(join(tmpdir(), "ma q16 "));
  const runs: Record<string, unknown>[] = [];
  try {
    for (let run = 1; run <= Number(values.runs); run++) {
      const items: Item[] = [];
      let jsonOnly = 0;
      let calls = 0;
      for (let i = 0; i < prompts.length; i += 10) {
        const batch = prompts.slice(i, i + 10).map((p) => ({ id: p.id, text: p.text }));
        const r = runClaude(values.model, extractorPrompt(batch), cwd);
        calls++;
        if (r.ok) jsonOnly++;
        items.push(...r.items);
        process.stderr.write(`run ${run}: batch ${calls} -> ${r.items.length} items\n`);
      }
      const positives = prompts.filter((p) => p.expect.length > 0);
      const negatives = prompts.filter((p) => p.expect.length === 0);
      const recalled = positives.filter((p) => items.some((it) => it.prompt_id === p.id && p.expect.some((k) => matches(it, k)))).length;
      const correctItems = items.filter((it) => (byId.get(it.prompt_id)?.expect ?? []).some((k) => matches(it, k))).length;
      const falseOnNegatives = negatives.filter((p) => items.some((it) => it.prompt_id === p.id)).map((p) => p.id);
      const secretLeaks = items.filter((it) => {
        const p = byId.get(it.prompt_id);
        return prompts.some((q) => (q.secret ?? []).some((s) => `${it.content} ${it.span}`.toLowerCase().includes(s))) || !p;
      }).length;
      const badSpans = items.filter((it) => {
        const p = byId.get(it.prompt_id);
        return !p || it.span.length < 8 || !p.text.includes(it.span);
      }).length;
      const tooLong = items.filter((it) => it.content.length > 400).length;
      const badKind = items.filter((it) => !["fact", "preference", "event"].includes(it.kind)).length;
      runs.push({
        run,
        calls,
        json_only_calls: jsonOnly,
        items: items.length,
        recall: { k: recalled, n: positives.length, ...wilson(recalled, positives.length) },
        precision: { k: correctItems, n: items.length, ...wilson(correctItems, items.length) },
        negatives_with_extraction: { k: falseOnNegatives.length, n: negatives.length, ids: falseOnNegatives, ...wilson(falseOnNegatives.length, negatives.length) },
        secret_or_unknown_id_items: secretLeaks,
        spans_not_verbatim_or_short: badSpans,
        content_over_400: tooLong,
        invalid_kind: badKind,
        extracted: items,
      });
      console.log(
        `run ${run}: recall ${recalled}/${positives.length}, precision ${correctItems}/${items.length}, ` +
          `negatives with an extraction ${falseOnNegatives.length}/${negatives.length} [${falseOnNegatives.join(" ")}], ` +
          `secrets ${secretLeaks}, bad spans ${badSpans}, JSON-only ${jsonOnly}/${calls}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (values.out) {
    writeFileSync(
      values.out,
      JSON.stringify({ question: "Q16", model: values.model, harness: "Claude Code headless (owner subscription, no API key)", labels: "author", prompt: "memory-policy.md §6.12 extractor-prompt", runs }, null, 2) + "\n",
    );
  }
}

if (import.meta.main) await main();
