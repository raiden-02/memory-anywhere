// `mema hook <tool> <event>` (clients.md §3): the session-start and prompt hooks of Claude Code,
// Codex and Cursor. A hook reads one JSON object on stdin, never throws, always exits 0, and
// prints only what its tool expects. Errors go to hooks.log as codes, never prompt text.
//
//                  session-start                                   prompt
//   input          cwd (Cursor: workspace_roots[0])                cwd, prompt
//   store call     POST /v1/session-start (1.5 s)                  POST /v1/writes op prompt
//   offline        cached context, "(offline copy from …)"         spooled, sent later
//   stdout         Claude Code, Codex: hookSpecificOutput          Cursor: {"continue": true};
//                  Cursor: {"additional_context": …}               others: nothing

import type { Paths } from "@memory-anywhere/contracts/paths";
import { redact } from "@memory-anywhere/contracts/redact";
import { idSource } from "@memory-anywhere/contracts/ids";
import type { SessionStartResponseT, ReposCheckResponseT, WriteResultT } from "@memory-anywhere/contracts/schemas/v1";
import { spoolRecordToEntry, type SpoolRecordT } from "@memory-anywhere/contracts/spool";
import type { ClientConfigT } from "./config.ts";
import { readRepoContext, readRepos, writeProfile, writeRepoContext, writeRepoState } from "./cache.ts";
import { logLine } from "./log.ts";
import { fromCursorRoot, NONE, repoIdentity } from "./repo-key.ts";
import { drain, spoolWrite } from "./spool.ts";
import { StoreError, type StoreClient } from "./store-client.ts";

export type HookTool = "claude-code" | "codex" | "cursor";
export type HookEvent = "session-start" | "prompt";

/** Cursor names its events differently; both spellings are accepted. */
export function hookEvent(name: string): HookEvent | undefined {
  if (name === "session-start" || name === "sessionStart") return "session-start";
  if (name === "prompt" || name === "beforeSubmitPrompt") return "prompt";
  return undefined;
}

export interface HookDeps {
  readonly paths: Paths;
  readonly config: ClientConfigT;
  readonly store: StoreClient;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
}

const MAX_CHARS: Record<HookTool, number> = { "claude-code": 9000, codex: 6000, cursor: 6000 };
const HOOK_BUDGET_MS = 2500;
const REPO_CHECK_MS = 500;
/** Claude Code runs the prompt hook asynchronously; the others wait for it, so it must return fast. */
const PROMPT_SEND_MS: Record<HookTool, number> = { "claude-code": 3000, codex: 150, cursor: 150 };

interface HookInput {
  readonly session_id?: string;
  readonly conversation_id?: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly workspace_roots?: readonly string[];
  readonly cursor_version?: string;
}

/**
 * Reads stdin until one complete JSON object has arrived (Cursor may keep stdin open), the
 * stream ends, or the timeout passes.
 */
export function readHookInput(stdin: NodeJS.ReadableStream, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    const done = (value: unknown): void => {
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      if ("pause" in stdin && typeof stdin.pause === "function") stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(() => done(text ? tryParse(text) : undefined), timeoutMs);
    stdin.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
      const parsed = tryParse(text);
      if (parsed !== undefined) done(parsed);
    });
    stdin.on("end", () => done(tryParse(text)));
  });
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

/** The folder the tool is working in. */
function workingDir(tool: HookTool, input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  if (tool === "cursor") {
    const root = input.workspace_roots?.[0];
    return root ? fromCursorRoot(root) : env["CURSOR_PROJECT_DIR"];
  }
  return input.cwd;
}

function output(tool: HookTool, event: HookEvent, context: string | undefined): string {
  if (event === "prompt") return tool === "cursor" ? JSON.stringify({ continue: true }) : "";
  if (context === undefined) return tool === "cursor" ? JSON.stringify({}) : "";
  const text = [...context].slice(0, MAX_CHARS[tool]).join("");
  return tool === "cursor"
    ? JSON.stringify({ additional_context: text })
    : JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
}

export async function runHook(tool: HookTool, event: HookEvent, raw: unknown, deps: HookDeps): Promise<string> {
  const started = deps.now();
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as HookInput;
  // ADR-0110: Cursor may run Claude Code's user hooks; such a call carries cursor_version and is ignored.
  if (tool === "claude-code" && input.cursor_version !== undefined) return "";
  try {
    const dir = workingDir(tool, input, deps.env);
    if (!dir) return output(tool, event, undefined);
    const repo = repoIdentity(dir, deps.config.repos.deny_remotes);
    const session = (input.session_id ?? input.conversation_id ?? "unknown").slice(0, 128);
    const result = event === "session-start" ? await sessionStart(tool, repo, session, deps) : await prompt(tool, repo, session, input.prompt ?? "", deps);
    // Session-start has time to spare for older spooled writes; a prompt hook must return quickly.
    if (event === "session-start") await drain(deps.paths, deps.store, started + HOOK_BUDGET_MS, deps.now).catch(() => undefined);
    return result;
  } catch (e) {
    logLine(deps.paths.hooksLog, { tool, event, error: e instanceof StoreError ? e.kind : (e as Error).name });
    return output(tool, event, undefined);
  }
}

async function sessionStart(tool: HookTool, repo: ReturnType<typeof repoIdentity>, session: string, deps: HookDeps): Promise<string> {
  try {
    const r = await deps.store.request<SessionStartResponseT>(
      "POST", "/v1/session-start", { tool, repo_key: repo.repoKey, session_id: session, max_chars: MAX_CHARS[tool] }, deps.config.network.session_start_timeout_ms,
      { tool, repoKey: repo.repoKey, session },
    );
    if (!r) return output(tool, "session-start", undefined);
    writeProfile(deps.paths, r.profile);
    if (repo.repoKey !== NONE) {
      writeRepoState(deps.paths, repo.repoKey, { enabled: r.repo_enabled, capture: r.capture_enabled, root: repo.root, checked_at: new Date(deps.now()).toISOString() });
      if (r.repo_enabled) writeRepoContext(deps.paths, repo.repoKey, r.context);
    }
    return output(tool, "session-start", r.context);
  } catch (e) {
    if (!(e instanceof StoreError) || e.kind !== "offline") throw e;
    const cached = repo.repoKey !== NONE ? readRepoContext(deps.paths, repo.repoKey) : undefined;
    if (!cached) return output(tool, "session-start", undefined);
    return output(tool, "session-start", `(offline copy from ${cached.generatedAt})\n${cached.text}`);
  }
}

/** Whether prompts from this repo may leave the PC: the cache, else a 500 ms check, else no. */
async function enabled(repoKey: string, root: string, deps: HookDeps): Promise<boolean> {
  const cached = readRepos(deps.paths)[repoKey];
  if (cached) return cached.enabled;
  try {
    const r = await deps.store.request<ReposCheckResponseT>("POST", "/v1/repos/check", { repo_key: repoKey }, REPO_CHECK_MS);
    if (!r) return false;
    writeRepoState(deps.paths, repoKey, { enabled: r.enabled, capture: r.capture, root, checked_at: new Date(deps.now()).toISOString() });
    return r.enabled;
  } catch {
    return false;
  }
}

async function prompt(tool: HookTool, repo: ReturnType<typeof repoIdentity>, session: string, text: string, deps: HookDeps): Promise<string> {
  if (repo.repoKey === NONE || text.trim() === "" || !(await enabled(repo.repoKey, repo.root, deps))) return output(tool, "prompt", undefined);
  const record: Omit<SpoolRecordT, "format_version"> = {
    idempotency_key: idSource().newId("spl", deps.now()),
    spooled_at: new Date(deps.now()).toISOString(),
    op: "prompt",
    tool,
    repo_key: repo.repoKey,
    session_id: session,
    payload: { prompt: [...redact(text).text].slice(0, 8000).join("") },
  };
  if (tool === "claude-code") {
    // Async hook: send now, and spool the same record (same key) only if the send fails.
    try {
      const r = await deps.store.request<{ results: WriteResultT[] }>("POST", "/v1/writes", { entries: [spoolRecordToEntry({ format_version: 1, ...record } as SpoolRecordT)] },
        PROMPT_SEND_MS[tool], { tool, repoKey: repo.repoKey, session });
      if (r?.results[0]) return output(tool, "prompt", undefined);
    } catch (e) {
      if (!(e instanceof StoreError) || e.kind === "rejected") return output(tool, "prompt", undefined);
    }
    spoolWrite(deps.paths, record);
    return output(tool, "prompt", undefined);
  }
  // Codex and Cursor wait for the hook: spool first, then give the drain a short budget.
  spoolWrite(deps.paths, record);
  await drain(deps.paths, deps.store, deps.now() + PROMPT_SEND_MS[tool], deps.now).catch(() => undefined);
  return output(tool, "prompt", undefined);
}
