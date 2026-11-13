// Suite A (evals.md §3.4): does the agent use memory when it should, and only then? Each prompt
// runs in a headless Claude Code session against a fresh store holding a small persona, with and
// without the custom instruction. What the agent did is read from the recording proxy (which tools
// it called) and the store (what it saved), never from its reply.
//
//   personal, expects recall  → it should call memory_recall or memory_profile
//   personal, expects save    → it should call memory_save (the user states a lasting fact)
//   general,  expects none    → it should call neither
//
// Reported, not gated (M2): author-labelled prompts, one client (Claude Code), no hooks.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CLIENT_TEXTS } from "@memory-anywhere/contracts/policy-data";
import { MEMORY_TOOLS, runClaude, SERVER_NAME, startEvalStore } from "./headless.ts";
import { ROOT } from "./suite-s.ts";
import { wilson } from "./stats.ts";

export const PROMPTS_FILE = join(ROOT, "evals", "datasets", "a", "prompts.jsonl");

const Prompt = z.strictObject({
  id: z.string().regex(/^A-[PSN]\d{3}$/u),
  prompt: z.string().min(1),
  personal: z.boolean(),
  expects: z.enum(["recall", "save", "none"]),
  save_label: z.string().optional(),
});
export type APrompt = z.infer<typeof Prompt>;

/** The user the store knows: the facts personal prompts can use. */
export const PERSONA = [
  "Works as a data engineer at Northwind",
  "Lives in Lisbon",
  "Partner is named Sam",
  "Is learning Japanese",
  "Prefers concise answers with code examples",
  "Uses VS Code on Windows 11",
  "Main project memory-anywhere uses TypeScript and SQLite",
  "Runs every morning before work",
  "Prefers metric units",
  "Usual coffee order is a flat white",
];

export function loadPrompts(file = PROMPTS_FILE): APrompt[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => Prompt.parse(JSON.parse(l)));
}

export interface ARun {
  readonly id: string;
  readonly variant: "instruction" | "no_instruction";
  readonly expects: APrompt["expects"];
  readonly recalled: boolean;
  readonly saved: boolean;
  readonly calls: string[];
  readonly error?: string;
}

const RECALL = new Set(["memory_recall", "memory_profile"]);

export async function runPrompt(p: APrompt, variant: ARun["variant"], o: { model: string; timeoutMs: number }): Promise<ARun> {
  const store = await startEvalStore(PERSONA);
  const work = mkdtempSync(join(tmpdir(), "ma suite a "));
  try {
    const session = `suite-a:${p.id}:${variant}`;
    store.userSaid(p.prompt, session);
    const config = join(work, "mcp.json");
    store.writeMcpConfig(config, session);
    const r = await runClaude([
      "-p", p.prompt, "--model", o.model, "--output-format", "json", "--no-session-persistence",
      "--restricted", "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--allowedTools", MEMORY_TOOLS.join(","),
      ...(variant === "instruction" ? ["--append-system-prompt", CLIENT_TEXTS["custom-instruction"]] : []),
    ], { cwd: work, timeoutMs: o.timeoutMs });
    const calls = store.calls.map((c) => c.replace(`mcp__${SERVER_NAME}__`, ""));
    const error = r.timedOut ? "timed out" : r.code !== 0 ? `exit ${r.code}` : undefined;
    return { id: p.id, variant, expects: p.expects, recalled: calls.some((c) => RECALL.has(c)), saved: calls.includes("memory_save"), calls, ...(error ? { error } : {}) };
  } finally {
    await store.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

interface Rate {
  readonly k: number;
  readonly n: number;
  readonly ci95: [number, number];
}
const rate = (k: number, n: number): Rate => ({ k, n, ci95: wilson(k, n).ci95 });

export interface SuiteAResult {
  readonly suite: "A";
  readonly client: "claude-code-headless";
  readonly model: string;
  readonly labels: "author";
  readonly variants: Record<ARun["variant"], { recall_when_personal: Rate; save_when_stated: Rate; false_recall: Rate; spurious_save: Rate }>;
  readonly runs: ARun[];
}

export async function runSuiteA(o: { model: string; timeoutMs?: number; only?: ReadonlySet<string>; log?: (line: string) => void }): Promise<SuiteAResult> {
  const prompts = loadPrompts().filter((p) => !o.only || o.only.has(p.id));
  const runs: ARun[] = [];
  for (const variant of ["instruction", "no_instruction"] as const) {
    for (const p of prompts) {
      const r = await runPrompt(p, variant, { model: o.model, timeoutMs: o.timeoutMs ?? 180_000 });
      o.log?.(`${p.id} ${variant}: ${r.calls.join(",") || "no memory tools"}${r.error ? ` (${r.error})` : ""}`);
      runs.push(r);
    }
  }
  const of = (v: ARun["variant"], e: ARun["expects"]) => runs.filter((r) => r.variant === v && r.expects === e);
  const variants = Object.fromEntries((["instruction", "no_instruction"] as const).map((v) => [v, {
    recall_when_personal: rate(of(v, "recall").filter((r) => r.recalled).length, of(v, "recall").length),
    save_when_stated: rate(of(v, "save").filter((r) => r.saved).length, of(v, "save").length),
    false_recall: rate(of(v, "none").filter((r) => r.recalled).length, of(v, "none").length),
    spurious_save: rate(of(v, "none").filter((r) => r.saved).length, of(v, "none").length),
  }])) as SuiteAResult["variants"];
  return { suite: "A", client: "claude-code-headless", model: o.model, labels: "author", variants, runs };
}
