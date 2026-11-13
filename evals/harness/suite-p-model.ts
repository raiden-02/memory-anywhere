// Suite P, model stage (evals.md §3.3): short conversations with a per-turn label of what should
// end up stored, run as one multi-turn headless Claude Code session each, and scored on what the
// store holds afterwards (never on the agent's reply):
//
//   save     an active memory holds every keyword of the turn
//   observe  an observation holds them (a single mention of a taste, or something inferred);
//            an active memory is "over-saved"
//   skip     nothing stored holds them (a task detail, something transient, a sensitive topic
//            the user did not ask to keep)
//
// Each user turn is logged as the plugin's prompt hook would, so the server can verify user words.
// Reported, not gated (M2): author-labelled conversations, one client (Claude Code).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MEMORY_TOOLS, runClaude, startEvalStore, storedTexts } from "./headless.ts";
import { ROOT } from "./suite-s.ts";
import { wilson } from "./stats.ts";

export const CONVERSATIONS_FILE = join(ROOT, "evals", "datasets", "p", "conversations.jsonl");

const Turn = z.strictObject({
  user: z.string().min(1),
  label: z.enum(["save", "observe", "skip"]),
  /** Lower-case words that identify the fact in whatever wording the agent stores it. */
  keywords: z.array(z.string().min(2)).min(1),
});
const Conversation = z.strictObject({ id: z.string().regex(/^PM-\d{3}$/u), turns: z.array(Turn).min(1).max(6) });
export type PConversation = z.infer<typeof Conversation>;

export function loadConversations(file = CONVERSATIONS_FILE): PConversation[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => Conversation.parse(JSON.parse(l)));
}

export type TurnOutcome = "stored" | "observed" | "over_saved" | "missed" | "kept_out" | "false_save";

export interface TurnResult {
  readonly conversation: string;
  readonly turn: number;
  readonly label: z.infer<typeof Turn>["label"];
  readonly outcome: TurnOutcome;
}

const holds = (texts: readonly string[], keywords: readonly string[]): boolean => texts.some((t) => keywords.every((k) => t.toLowerCase().includes(k)));

export function scoreTurn(label: z.infer<typeof Turn>["label"], keywords: readonly string[], stored: { active: string[]; observations: string[] }): TurnOutcome {
  const active = holds(stored.active, keywords);
  const observed = holds(stored.observations, keywords);
  if (label === "save") return active ? "stored" : observed ? "observed" : "missed";
  if (label === "observe") return active ? "over_saved" : observed ? "observed" : "missed";
  return active || observed ? "false_save" : "kept_out";
}

export async function runConversation(c: PConversation, o: { model: string; timeoutMs: number }): Promise<{ turns: TurnResult[]; error?: string }> {
  const store = await startEvalStore();
  const work = mkdtempSync(join(tmpdir(), "ma suite p "));
  try {
    const session = `suite-p:${c.id}`;
    for (const t of c.turns) store.userSaid(t.user, session);
    const config = join(work, "mcp.json");
    store.writeMcpConfig(config, session);
    const stdin = c.turns.map((t) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: t.user }] } })).join("\n") + "\n";
    const r = await runClaude([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", o.model, "--no-session-persistence",
      "--restricted", "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--allowedTools", MEMORY_TOOLS.join(","),
    ], { cwd: work, timeoutMs: o.timeoutMs, stdin });
    const stored = storedTexts(store);
    const turns = c.turns.map((t, i) => ({ conversation: c.id, turn: i + 1, label: t.label, outcome: scoreTurn(t.label, t.keywords, stored) }));
    const error = r.timedOut ? "timed out" : r.code !== 0 ? `exit ${r.code}` : undefined;
    return { turns, ...(error ? { error } : {}) };
  } finally {
    await store.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

export interface SuitePModelResult {
  readonly suite: "P";
  readonly stage: "model";
  readonly client: "claude-code-headless";
  readonly model: string;
  readonly labels: "author";
  readonly n_conversations: number;
  /** save: stored / all save turns; observe: observed / all observe turns; skip: kept out / all skip turns. */
  readonly rates: Record<"save" | "observe" | "skip", { k: number; n: number; ci95: [number, number] }>;
  readonly outcomes: Record<string, Record<TurnOutcome, number>>;
  readonly errors: number;
  readonly turns: TurnResult[];
}

export async function runSuitePModel(o: { model: string; timeoutMs?: number; log?: (line: string) => void }): Promise<SuitePModelResult> {
  const conversations = loadConversations();
  const turns: TurnResult[] = [];
  let errors = 0;
  for (const c of conversations) {
    const r = await runConversation(c, { model: o.model, timeoutMs: o.timeoutMs ?? 300_000 });
    if (r.error) errors++;
    o.log?.(`${c.id}: ${r.turns.map((t) => `${t.label}→${t.outcome}`).join(", ")}${r.error ? ` (${r.error})` : ""}`);
    turns.push(...r.turns);
  }
  const good: Record<"save" | "observe" | "skip", TurnOutcome> = { save: "stored", observe: "observed", skip: "kept_out" };
  const rates = Object.fromEntries((["save", "observe", "skip"] as const).map((l) => {
    const n = turns.filter((t) => t.label === l).length;
    const k = turns.filter((t) => t.label === l && t.outcome === good[l]).length;
    return [l, { k, n, ci95: wilson(k, n).ci95 }];
  })) as SuitePModelResult["rates"];
  const outcomes: SuitePModelResult["outcomes"] = {};
  for (const t of turns) {
    const row = (outcomes[t.label] ??= { stored: 0, observed: 0, over_saved: 0, missed: 0, kept_out: 0, false_save: 0 });
    row[t.outcome]++;
  }
  return { suite: "P", stage: "model", client: "claude-code-headless", model: o.model, labels: "author", n_conversations: conversations.length, rates, outcomes, errors, turns };
}
