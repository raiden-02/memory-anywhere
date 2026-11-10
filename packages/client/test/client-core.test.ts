// The client's building blocks: repo keys (topology-and-ipc.md §8), the spool (§9), the unified
// diff, and the per-tool install plans (clients.md §3, §6).

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveToolPaths } from "@memory-anywhere/contracts/paths";
import { afterEach, describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff.ts";
import { codexPluginManifest, planClaudeCode, planCodex, planCursor, planSkill } from "../src/install.ts";
import { launchAgentPlist, registerAndStart, RUN_KEY, runValue, serverToml, systemdUnit, TASK_NAME, windowsLauncher } from "../src/local-server.ts";
import { denied, fromCursorRoot, NONE, normalizeRemote, proxyRepoDir, repoIdentity } from "../src/repo-key.ts";
import { drain, enforceLimits, spoolStats, spoolWrite } from "../src/spool.ts";
import { StoreClient } from "../src/store-client.ts";
import { tempHome } from "./helpers.ts";

const homes: ReturnType<typeof tempHome>[] = [];
afterEach(() => homes.splice(0).forEach((h) => h.cleanup()));
const home = (): ReturnType<typeof tempHome> => {
  const h = tempHome();
  homes.push(h);
  return h;
};

describe("repo key", () => {
  it.each([
    ["git@github.com:Owner/Repo.git", "https://github.com/Owner/Repo"],
    ["ssh://git@GitHub.com:22/Owner/Repo.git", "https://github.com/Owner/Repo"],
    ["https://user:pw@Example.COM/a/b/", "https://example.com/a/b"],
  ])("%s → %s", (remote, normalized) => {
    expect(normalizeRemote(remote)).toBe(normalized);
  });

  it("matches deny entries by host or host/path prefix", () => {
    expect(denied("https://git.corp.example.com/team/x", ["git.corp.example.com"])).toBe(true);
    expect(denied("https://github.com/acme/x", ["github.com/acme"])).toBe(true);
    expect(denied("https://github.com/acmeco/x", ["github.com/acme"])).toBe(false);
  });

  it("keys a repo by its remote, falls back to its path, and never enables the home folder", () => {
    const h = home();
    const repo = path.join(h.dir, "my repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const byPath = repoIdentity(repo, [], h.dir);
    expect(byPath.repoKey).toMatch(/^rk_[0-9a-f]{32}$/u);
    expect(byPath.displayName).toBe("my repo");
    spawnSync("git", ["remote", "add", "origin", "git@github.com:Owner/Memory-Anywhere.git"], { cwd: repo });
    const byRemote = repoIdentity(path.join(repo), [], h.dir);
    expect(byRemote).toMatchObject({ remote: "https://github.com/Owner/Memory-Anywhere", displayName: "Memory-Anywhere" });
    expect(byRemote.repoKey).not.toBe(byPath.repoKey);
    expect(repoIdentity(repo, ["github.com/owner"], h.dir).repoKey).toBe(NONE);
    expect(repoIdentity(h.dir, [], h.dir).repoKey).toBe(NONE);
  });

  it("takes the proxy's repo folder from the tool's project variable, else its working directory", () => {
    expect(proxyRepoDir({ CLAUDE_PROJECT_DIR: "/claude ws" }, "/cwd")).toBe("/claude ws");
    expect(proxyRepoDir({ CURSOR_PROJECT_DIR: "/cursor ws" }, "/cwd")).toBe("/cursor ws");
    expect(proxyRepoDir({}, "/cwd")).toBe("/cwd");
  });

  it("reads Cursor's URL-style workspace roots", () => {
    expect(fromCursorRoot("/C:/Users/me/my repo")).toBe("C:\\Users\\me\\my repo");
    expect(fromCursorRoot("/home/me/repo")).toBe("/home/me/repo");
  });
});

const record = (n: number) => ({
  idempotency_key: `spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B${String(n).padStart(2, "0")}`, spooled_at: "2026-11-10T12:00:00.000Z", op: "prompt" as const,
  tool: "claude-code" as const, repo_key: "rk_0123456789abcdef0123456789abcdef", session_id: "s", payload: { prompt: `prompt ${n}` },
});

function fakeStore(answer: (entries: { idempotency_key: string }[]) => Response): StoreClient {
  return new StoreClient("http://store.test", "t", (async (_url: string | URL | Request, init?: RequestInit) => answer((JSON.parse(String(init?.body)) as { entries: { idempotency_key: string }[] }).entries)) as typeof fetch);
}

describe("spool", () => {
  it("replays entries in order, deletes them on a definitive answer, and logs rejections", async () => {
    const { paths } = home();
    for (const n of [2, 1, 3]) spoolWrite(paths, record(n));
    const seen: string[] = [];
    const store = fakeStore((entries) => {
      seen.push(...entries.map((e) => e.idempotency_key));
      return Response.json({ results: entries.map((e, i) => ({ idempotency_key: e.idempotency_key, outcome: i === 0 ? "rejected" : "active", reason: i === 0 ? "repo_not_enabled" : "prompt_stored" })) });
    });
    const r = await drain(paths, store, Date.now() + 5000);
    expect(r).toEqual({ sent: 3, remaining: 0, busy: false });
    expect(seen.map((k) => k.slice(-2))).toEqual(["01", "02", "03"]);
    const log = readFileSync(paths.spoolRejectedLog, "utf8");
    expect(log).toContain("repo_not_enabled");
    expect(log).not.toContain("prompt 1");
  });

  it("keeps everything while the store is down", async () => {
    const { paths } = home();
    spoolWrite(paths, record(1));
    const offline = new StoreClient("http://127.0.0.1:9", "t");
    expect(await drain(paths, offline, Date.now() + 2000)).toMatchObject({ sent: 0, remaining: 1 });
  });

  it("moves a record that fails to parse three times to dead", async () => {
    const { paths } = home();
    spoolWrite(paths, record(1));
    writeFileSync(path.join(paths.spoolDir, "01JC9Z3N4V8Q2W5X7Y9Z0A1B99.json"), "{ broken");
    const store = fakeStore((entries) => Response.json({ results: entries.map((e) => ({ idempotency_key: e.idempotency_key, outcome: "active", reason: "prompt_stored" })) }));
    for (let i = 0; i < 3; i++) await drain(paths, store, Date.now() + 2000);
    expect(readdirSync(paths.spoolDeadDir)).toEqual(["01JC9Z3N4V8Q2W5X7Y9Z0A1B99.json"]);
    expect(spoolStats(paths).count).toBe(0);
  });

  it("drops the oldest entries past the size limit", () => {
    const { paths } = home();
    for (const n of [1, 2, 3]) spoolWrite(paths, record(n));
    const size = spoolStats(paths).bytes;
    expect(enforceLimits(paths, { maxBytes: Math.floor(size / 2), maxAgeDays: 30 }, Date.now(), () => undefined)).toBe(2);
  });
});

describe("diff", () => {
  it("shows a changed line with context", () => {
    expect(unifiedDiff("x.json", "a\nb\nc\n", "a\nB\nc\n")).toBe("--- a/x.json\n+++ b/x.json\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    expect(unifiedDiff("x", "same", "same")).toBe("");
  });
});

describe("install plans", () => {
  it("adds our Cursor hooks next to the user's own, and replaces stale ones", () => {
    const h = home();
    const tools = resolveToolPaths({ platform: process.platform as "win32", env: {}, home: h.dir });
    mkdirSync(path.dirname(tools.cursorHooksFile), { recursive: true });
    writeFileSync(tools.cursorHooksFile, JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "echo mine" }, { command: 'node "old\\memory-anywhere.mjs" hook cursor sessionStart' }] } }));
    const plan = planCursor({ paths: h.paths, tools, pluginsDir: "plugins", claudeServers: [] });
    const hooks = JSON.parse(plan.files.find((f) => f.path === tools.cursorHooksFile)?.after ?? "{}") as { hooks: Record<string, { command: string }[]> };
    expect(hooks.hooks["sessionStart"]?.map((c) => c.command)).toEqual(["echo mine", `node "${path.join(tools.cursorPluginDir, "dist", "memory-anywhere.mjs")}" hook cursor sessionStart`]);
    expect(hooks.hooks["beforeSubmitPrompt"]).toHaveLength(1);
  });

  it("writes Codex's legacy plugin layout with Windows hook commands, and the IDE server entry", () => {
    const h = home();
    const tools = resolveToolPaths({ platform: process.platform as "win32", env: {}, home: h.dir });
    const manifest = codexPluginManifest("C:\\data dir\\bin\\memory-anywhere.mjs") as { hooks: { hooks: Record<string, { hooks: { commandWindows: string }[] }[]> } };
    expect(manifest.hooks.hooks["SessionStart"]?.[0]?.hooks[0]?.commandWindows).toBe('node "C:\\data dir\\bin\\memory-anywhere.mjs" hook codex session-start');
    const plan = planCodex({ paths: h.paths, tools, pluginsDir: "plugins", claudeServers: [] }, "bundle.mjs");
    expect(plan.files.map((f) => path.relative(h.dir, f.path).replaceAll("\\", "/"))).toEqual([
      "data/plugins/codex-marketplace/.agents/plugins/marketplace.json",
      "data/plugins/codex-marketplace/plugins/memory-anywhere/.codex-plugin/plugin.json",
      "data/plugins/codex-marketplace/plugins/memory-anywhere/.mcp.json",
      ".codex/config.toml",
    ]);
  });

  it("disables project copies in Claude Code and denies a claude.ai copy", () => {
    const h = home();
    const tools = resolveToolPaths({ platform: process.platform as "win32", env: {}, home: h.dir });
    const plan = planClaudeCode({ paths: h.paths, tools, pluginsDir: "plugins", claudeServers: ["claude.ai memory-anywhere", "github"] });
    expect(JSON.parse(plan.files[0]?.after ?? "{}")).toEqual({ disabledMcpjsonServers: ["memory-anywhere"], deniedMcpServers: [{ serverName: "claude.ai memory-anywhere" }] });
    expect(planSkill(tools).files[0]?.after).toMatch(/^---\nname: memory-anywhere/u);
  });
});

describe("local server lifecycle", () => {
  it("writes server.toml with the shared token and model paths", () => {
    const { paths } = home();
    expect(serverToml(paths)).toContain(`local_token_file = ${JSON.stringify(paths.localTokenFile)}`);
  });

  it("registers the Windows start at logon in HKCU Run, writes the launcher, and starts it", () => {
    const { paths } = home();
    const launcher = path.join(paths.localServerDataDir, "start-hidden.js");
    const calls: { command: string; args: readonly string[] }[] = [];
    const started: { command: string; args: readonly string[] }[] = [];
    registerAndStart(["C:\\node.exe", "C:\\my repo\\cli.ts", "start", "--local"], launcher, (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    }, "win32", "unused", (command, args) => void started.push({ command, args }));
    expect(calls).toEqual([{ command: "reg.exe", args: ["add", RUN_KEY, "/v", TASK_NAME, "/t", "REG_SZ", "/d", runValue(launcher), "/f"] }]);
    expect(started).toEqual([{ command: "wscript.exe", args: ["//B", "//Nologo", launcher] }]);
    const text = readFileSync(launcher).subarray(2).toString("utf16le");
    expect(text).toContain(String.raw`shell.Run("\"C:\\node.exe\" \"C:\\my repo\\cli.ts\" \"start\" \"--local\"", 0, true)`);
  });

  it("escapes arguments in the macOS and Linux units", () => {
    expect(launchAgentPlist(["/a & b/node"])).toContain("<string>/a &amp; b/node</string>");
    expect(systemdUnit(["/my dir/node", 'x"y'])).toContain('ExecStart="/my dir/node" "x\\"y"');
  });
});

describe.runIf(process.platform === "win32")("Windows launcher", () => {
  it("starts the command hidden through Windows Script Host, and retries only a crash", () => {
    const h = home();
    const out = path.join(h.dir, "launched file.txt");
    const launcher = path.join(h.dir, "launcher dir", "start-hidden.js");
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, windowsLauncher([process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], 'ran'); process.exit(0)", out]));
    const r = spawnSync("cscript.exe", ["//B", "//Nologo", launcher], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("ran");
    const text = readFileSync(launcher).subarray(2).toString("utf16le");
    expect(text).toContain("if (code === 0) break;");
    expect(text).toContain("for (var attempt = 0; attempt < 4; attempt++)");
  });
});
