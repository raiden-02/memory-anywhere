// Prompt intake and capture (write-path.md §10.1, §10.3).
//
// The prompt hook sends each user prompt (already redacted on the PC) as a `/v1/writes` entry with
// `op: prompt`. The server keeps it for 24 hours, so the coding-tool `user_words` check can find
// the user's words. In repos with capture on, prompts are batched per tool session into an
// `extract` job; without an LLM, a sentence with remember intent becomes an observation.

import { createHash } from "node:crypto";
import { redact } from "@memory-anywhere/contracts/redact";
import { norm } from "@memory-anywhere/contracts/normalize";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { transaction, prepared } from "../store/db.ts";
import { REMEMBER_INTENT } from "../policy/generated.ts";
import { lexicon } from "../policy/lexicon.ts";
import { save, type WriteEnv } from "./pipeline.ts";
import type { Caller } from "./types.ts";

const REMEMBER = lexicon(REMEMBER_INTENT, "substring");
const BATCH_IDLE_MS = 10 * 60 * 1000;
const BATCH_MAX = 20;
const PROMPT_MAX = 8000;
/** No-LLM capture's extractor version, part of capture idempotency keys (write-path.md §2.3). */
export const NO_LLM_EXTRACTOR = "nollm-1";

export interface PromptResult {
  readonly idempotency_key: string;
  readonly outcome: "active" | "rejected";
  readonly reason: "prompt_stored" | "repo_not_enabled";
}

interface ExtractPayload {
  readonly client_id: string;
  readonly repo_key: string;
  readonly tool_session: string;
  readonly prompt_ids: string[];
}

export function intakePrompt(env: WriteEnv, caller: Caller, key: string, prompt: string, toolSession: string, observedAt: number): PromptResult {
  const { ctx, config } = env;
  return transaction(ctx.db, () => {
    const stored = prepared(ctx.db, "SELECT result_json FROM write_request WHERE idempotency_key = ?").get(key) as { result_json: string } | undefined;
    if (stored) return JSON.parse(stored.result_json) as PromptResult;
    const now = ctx.clock.now();
    const repo = prepared(ctx.db, "SELECT enabled, capture FROM repo WHERE repo_key = ?").get(caller.repoKey ?? "none") as
      | { enabled: number; capture: number }
      | undefined;
    const accepted = caller.clientClass === "coding" && repo?.enabled === 1;
    const result: PromptResult = accepted
      ? { idempotency_key: key, outcome: "active", reason: "prompt_stored" }
      : { idempotency_key: key, outcome: "rejected", reason: "repo_not_enabled" };
    if (accepted) {
      const id = ctx.ids.newId("spr", now);
      prepared(ctx.db, "INSERT INTO session_prompt (id, client_id, repo_key, tool_session, prompt, received_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, caller.clientId, caller.repoKey ?? "none", toolSession, redact(prompt).text.slice(0, PROMPT_MAX), iso(now),
          iso(now + config.retention.session_prompt_hours * HOUR_MS));
      if (repo?.capture === 1) addToBatch(ctx, caller, toolSession, id, now);
    }
    prepared(ctx.db, 
        `INSERT INTO write_request (idempotency_key, client_id, op, received_at, observed_at, outcome, reason, result_json, expires_at)
         VALUES (?, ?, 'prompt', ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, caller.clientId, iso(now), iso(observedAt), result.outcome, result.reason, JSON.stringify(result),
        iso(now + config.retention.write_request_days * DAY_MS));
    return result;
  });
}

/** Adds a prompt to its session's open extraction batch (flushed after 10 idle minutes or 20 prompts). */
function addToBatch(ctx: StoreContext, caller: Caller, toolSession: string, promptId: string, now: number): void {
  const open = (prepared(ctx.db, "SELECT id, payload_json FROM job WHERE kind = 'extract' AND status = 'queued'").all() as { id: string; payload_json: string }[])
    .map((j) => ({ id: j.id, payload: JSON.parse(j.payload_json) as ExtractPayload }))
    .find((j) => j.payload.client_id === caller.clientId && j.payload.repo_key === caller.repoKey && j.payload.tool_session === toolSession);
  if (open) {
    const ids = [...open.payload.prompt_ids, promptId];
    const nextAt = ids.length >= BATCH_MAX ? now : now + BATCH_IDLE_MS;
    prepared(ctx.db, "UPDATE job SET payload_json = ?, next_at = ? WHERE id = ?").run(JSON.stringify({ ...open.payload, prompt_ids: ids }), iso(nextAt), open.id);
    return;
  }
  const payload: ExtractPayload = { client_id: caller.clientId, repo_key: caller.repoKey ?? "none", tool_session: toolSession, prompt_ids: [promptId] };
  prepared(ctx.db, "INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, 'extract', ?, 0, ?, 'queued', ?)")
    .run(ctx.ids.newId("job", now), JSON.stringify(payload), iso(now + BATCH_IDLE_MS), iso(now));
}

/** Sentences of a prompt (split on `.`, `!`, `?` and newlines) that show remember intent. */
export function rememberSentences(prompt: string): string[] {
  return prompt
    .split(/[.!?\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "" && REMEMBER.matches(norm(s)));
}

/**
 * The `extract` job without an LLM (write-path.md §10.3): every sentence with remember intent
 * becomes an observation candidate (content = the sentence, kind fact), forced to `observation`
 * with reason `capture_no_llm`. Screens still apply: a secret, a sensitive topic or a suppressed
 * text is rejected, never staged.
 */
export async function runNoLlmExtract(env: WriteEnv, payloadJson: string): Promise<number> {
  const payload = JSON.parse(payloadJson) as ExtractPayload;
  let staged = 0;
  for (const promptId of payload.prompt_ids) {
    const row = prepared(env.ctx.db, "SELECT prompt FROM session_prompt WHERE id = ?").get(promptId) as { prompt: string | null } | undefined;
    if (!row?.prompt) continue;
    const sentences = rememberSentences(row.prompt);
    for (const [ordinal, sentence] of sentences.entries()) {
      if (sentence.includes("[REDACTED:")) continue;
      const caller: Caller = {
        clientId: payload.client_id, clientClass: "coding", channel: "capture", tier: 2, sessionKey: `${payload.client_id}:${payload.tool_session}`,
        repoKey: payload.repo_key, tool: undefined, floored: false, canElicit: false, elicitationAnswer: undefined,
      };
      const key = createHash("sha256").update(["capture", promptId, NO_LLM_EXTRACTOR, String(ordinal)].join("\n"), "utf8").digest("hex");
      const content = [...sentence].slice(0, 400).join("");
      const r = await save(env, caller, {
        content, kind: "fact", why_durable: "extracted from the user's prompt", user_words: [...sentence].slice(0, 200).join(""),
        explicit_request: true, entity: "self", scope: "global", change: "update",
      }, { idempotencyKey: key, observedAt: env.ctx.clock.now() });
      if (r.kind === "result" && r.outcome.outcome === "observation") staged++;
    }
  }
  return staged;
}
