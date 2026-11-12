// Hooks (clients.md §3) fed the payloads recorded from each tool in M0, and the stdio proxy
// (topology-and-ipc.md §5) relaying to a real local server, then answering offline.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoContext, writeRepoState } from "../src/cache.ts";
import { hookEvent, readHookInput, runHook, type HookTool } from "../src/hooks.ts";
import { builtInTools, hostTool, Proxy } from "../src/proxy.ts";
import { repoIdentity } from "../src/repo-key.ts";
import { spoolStats } from "../src/spool.ts";
import { StoreClient } from "../src/store-client.ts";
import { localConfig, localServer, tempHome, type LocalServer } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "evals", "fixtures", "hooks");
const fixture = (rel: string): Record<string, unknown> => {
  const j = JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8")) as Record<string, unknown>;
  return (j["payload"] as Record<string, unknown> | undefined) ?? j;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface World {
  readonly h: ReturnType<typeof tempHome>;
  readonly server: LocalServer;
  readonly repoDir: string;
  readonly repoKey: string;
}

/** A git repo with a space in its path, enabled on a running local server. */
async function world(): Promise<World> {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const server = await localServer();
  cleanups.push(() => {
    server.store.close();
  }, server.stop);
  const repoDir = path.join(h.dir, "work repo");
  mkdirSync(repoDir);
  spawnSync("git", ["init", "-q"], { cwd: repoDir });
  const { repoKey } = repoIdentity(repoDir, [], h.dir);
  server.store.db.prepare("INSERT INTO repo (repo_key, display_name, enabled, capture) VALUES (?, 'work repo', 1, 0)").run(repoKey);
  return { h, server, repoDir, repoKey };
}

const hook = (w: World, tool: HookTool, event: "session-start" | "prompt", input: Record<string, unknown>, store: StoreClient = w.server.client) =>
  runHook(tool, event, input, { paths: w.h.paths, config: localConfig(), store, env: {}, now: Date.now });

describe("hooks", () => {
  it("accepts both event spellings and reads stdin that is never closed", async () => {
    expect([hookEvent("sessionStart"), hookEvent("beforeSubmitPrompt"), hookEvent("x")]).toEqual(["session-start", "prompt", undefined]);
    const stdin = new PassThrough();
    const read = readHookInput(stdin, 5000);
    stdin.write('{"session_id":"a",');
    stdin.write('"cwd":"x"}');
    expect(await read).toEqual({ session_id: "a", cwd: "x" });
  });

  it("gives Claude Code the session-start context in its hook shape, and caches it", async () => {
    const w = await world();
    const out = JSON.parse(await hook(w, "claude-code", "session-start", { ...fixture("claude-code/2.1.319/session-start.json"), cwd: w.repoDir })) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("memory-anywhere is active for this repository");
    expect(readRepoContext(w.h.paths, w.repoKey)?.text).toBe(out.hookSpecificOutput.additionalContext);
  });

  it("maps Cursor's workspace_roots and answers in Cursor's shape", async () => {
    const w = await world();
    const root = `/${w.repoDir.replaceAll("\\", "/")}`.replace(/^\/\//u, "/");
    const out = JSON.parse(await hook(w, "cursor", "session-start", { ...fixture("cursor/3.29.9/sessionStart.json"), workspace_roots: [root] })) as { additional_context?: string };
    expect(out.additional_context).toContain("memory-anywhere is active for this repository");
    expect(await hook(w, "cursor", "prompt", { ...fixture("cursor/3.29.9/beforeSubmitPrompt.json"), workspace_roots: [root] })).toBe('{"continue":true}');
  });

  it("ignores a Claude Code hook call that comes from Cursor", async () => {
    const w = await world();
    expect(await hook(w, "claude-code", "session-start", { cwd: w.repoDir, cursor_version: "3.29.9" })).toBe("");
  });

  it("falls back to the cached context, marked as an offline copy", async () => {
    const w = await world();
    await hook(w, "codex", "session-start", { ...fixture("codex/0.167.0/session-start.json"), cwd: w.repoDir });
    const offline = new StoreClient("http://127.0.0.1:9", "t");
    const out = JSON.parse(await hook(w, "codex", "session-start", { cwd: w.repoDir, session_id: "s" }, offline)) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toMatch(/^\(offline copy from \d{4}-/u);
  });

  it("sends prompts from enabled repos only, redacted, and spools them while offline", async () => {
    const w = await world();
    const secret = ["ghp", "_0123456789abcdefghijABCDEFGHIJ012345"].join("");
    await hook(w, "claude-code", "prompt", { ...fixture("claude-code/2.1.319/prompt.json"), cwd: w.repoDir, prompt: `remember I use pnpm; token ${secret}` });
    const stored = w.server.store.db.prepare("SELECT prompt FROM session_prompt").all() as { prompt: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.prompt).toContain("remember I use pnpm");
    expect(stored[0]?.prompt).not.toContain(secret);

    const elsewhere = path.join(w.h.dir, "other repo");
    mkdirSync(elsewhere);
    spawnSync("git", ["init", "-q"], { cwd: elsewhere });
    await hook(w, "claude-code", "prompt", { cwd: elsewhere, session_id: "s", prompt: "private words" });
    expect(w.server.store.db.prepare("SELECT count(*) AS n FROM session_prompt").get()).toEqual({ n: 1 });

    const offline = new StoreClient("http://127.0.0.1:9", "t");
    await hook(w, "codex", "prompt", { cwd: w.repoDir, session_id: "s", prompt: "remember the deploy runs on fridays" }, offline);
    expect(spoolStats(w.h.paths).count).toBe(1);
    await hook(w, "codex", "session-start", { cwd: w.repoDir, session_id: "s" }); // drains the spool
    expect(spoolStats(w.h.paths).count).toBe(0);
    expect(w.server.store.db.prepare("SELECT count(*) AS n FROM session_prompt").get()).toEqual({ n: 2 });
  });
});

describe("proxy", () => {
  const proxyFor = (w: World, store: StoreClient = w.server.client) => {
    writeRepoState(w.h.paths, w.repoKey, { enabled: true, capture: false, root: w.repoDir, checked_at: new Date().toISOString() });
    return new Proxy({ paths: w.h.paths, config: localConfig(), store, tool: "claude-code", env: { CLAUDE_PROJECT_DIR: w.repoDir }, cwd: w.h.dir, now: Date.now });
  };

  it("relays tools/list and a save with its own pxs_ key", async () => {
    const w = await world();
    const proxy = proxyFor(w);
    expect(proxy.repoKey).toBe(w.repoKey);
    expect((await proxy.listTools()).map((t) => t.name)).toEqual(["memory_recall", "memory_profile", "memory_save", "memory_forget", "memory_status"]);
    const r = await proxy.callTool("memory_save", { content: "Ships releases on Fridays", kind: "fact", why_durable: "team habit" }, undefined);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { idempotency_key: string }).idempotency_key).toMatch(/^pxs_/u);
  });

  it("answers offline: saves are queued, corrections refused, recall from cache, status offline", async () => {
    const w = await world();
    const online = proxyFor(w);
    await online.listTools();
    await hook(w, "claude-code", "session-start", { cwd: w.repoDir, session_id: "s" });
    await w.server.stop();
    const proxy = proxyFor(w);
    const queued = await proxy.callTool("memory_save", { content: "Prefers tabs over spaces", kind: "preference", why_durable: "style" }, undefined);
    expect(queued.structuredContent).toMatchObject({ outcome: "queued", reason: "offline" });
    expect(spoolStats(w.h.paths).count).toBe(1);
    const correction = await proxy.callTool("memory_save", { content: "x", kind: "fact", why_durable: "y", supersedes: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" }, undefined);
    expect(correction).toMatchObject({ isError: true, _meta: { "memory-anywhere/error": { code: "STORE_UNAVAILABLE" } } });
    expect(correction.structuredContent).toBeUndefined();
    const recall = await proxy.callTool("memory_recall", { query: "anything" }, undefined);
    expect((recall.content as { text: string }[])[0]?.text).toMatch(/^Offline copy from /u);
    expect(recall.structuredContent).toMatchObject({ offline: true, items: [] });
    expect((await proxy.callTool("memory_status", {}, undefined)).structuredContent).toMatchObject({ health: "offline", spool_count: 1 });
    expect((await proxy.listTools()).map((t) => t.name)).toHaveLength(5); // from the tools cache
  });

  it("in Cursor, follows the repo of the latest Cursor hook, since one proxy serves every window", async () => {
    const w = await world();
    const proxy = new Proxy({ paths: w.h.paths, config: localConfig(), store: w.server.client, tool: "cursor", env: {}, cwd: w.h.dir, now: Date.now });
    expect(proxy.repoKey).not.toBe(w.repoKey);
    const root = `/${w.repoDir.replaceAll("\\", "/")}`.replace(/^\/\//u, "/");
    await hook(w, "cursor", "prompt", { workspace_roots: [root], session_id: "s", prompt: "remember that I write commit messages in the imperative mood" });
    expect(proxy.repoKey).toBe(w.repoKey);
    const r = await proxy.callTool("memory_save", { content: "Writes commit messages in the imperative mood", kind: "preference", why_durable: "habit", user_words: "I write commit messages in the imperative mood" }, undefined);
    expect(r.structuredContent).toMatchObject({ outcome: "active" });
  });

  it("serves Cursor when Cursor starts the imported Claude Code plugin, and Claude Code otherwise", () => {
    // Environments as observed on Windows: Cursor 3.29.9 and Claude Code 2.1.321.
    const cursor = { WORKSPACE_FOLDER_PATHS: "C:\\work\\first window", VSCODE_CWD: "C:\\Program Files\\cursor" };
    expect(hostTool("claude-code", cursor)).toBe("cursor");
    expect(hostTool("claude-code", { VSCODE_CWD: "/Applications/Cursor.app/Contents/Resources/app" })).toBe("cursor");
    // Claude Code started from a terminal inside Cursor or VS Code inherits VSCODE_* but sets CLAUDECODE.
    expect(hostTool("claude-code", { ...cursor, CLAUDECODE: "1", CLAUDE_PROJECT_DIR: "C:\\work\\repo" })).toBe("claude-code");
    expect(hostTool("claude-code", {})).toBe("claude-code");
    expect(hostTool("codex", cursor)).toBe("codex");
    expect(hostTool("cursor", {})).toBe("cursor");
  });

  it("lists the built-in tools when it has neither the store nor a cache", () => {
    const tools = builtInTools();
    expect(tools.map((t) => t.name)).toEqual(["memory_recall", "memory_profile", "memory_save", "memory_forget", "memory_status"]);
    expect(tools[2]?.description).toMatch(/policy P1\)$/u);
    expect(JSON.stringify(tools)).not.toContain('"$schema"');
  });
});
