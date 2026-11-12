// `mema doctor` (clients.md §6): each check says pass, warn or fail, and how to fix it. In local
// mode `local.token` replaces `auth.pc-grant`, and `dns` and `policy` do not apply.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { currentToolPaths, type ToolPaths } from "@memory-anywhere/contracts/paths";
import { accessToken } from "./auth.ts";
import { readProfile, readRepos } from "./cache.ts";
import { CLIENT_VERSION, loadClientConfig } from "./config.ts";
import type { CommandDeps } from "./commands.ts";
import { CODEX_MARKET, installDirs } from "./install.ts";
import { spoolStats } from "./spool.ts";
import { runTool } from "./tool-runner.ts";

export type Verdict = "pass" | "warn" | "fail";

export interface Check {
  readonly id: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly fix?: string;
}

const tool = (command: string, args: readonly string[]): string | undefined => {
  const r = runTool(command, args, 20_000);
  return r.status === 0 ? `${r.stdout}\n${r.stderr}` : undefined;
};

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const pass = (id: string, detail: string): Check => ({ id, verdict: "pass", detail });
const warn = (id: string, detail: string, fix: string): Check => ({ id, verdict: "warn", detail, fix });
const fail = (id: string, detail: string, fix: string): Check => ({ id, verdict: "fail", detail, fix });

async function storeChecks(d: CommandDeps): Promise<Check[]> {
  const out: Check[] = [];
  let health: { ok?: boolean; version?: string; min_client_version?: string } | undefined;
  try {
    health = await d.store.request("GET", "/v1/health", undefined, 2000);
  } catch {
    health = undefined;
  }
  out.push(health?.ok ? pass("store.reachable", `${d.store.url ?? ""} answers`) : fail("store.reachable", `no healthy store at ${d.store.url ?? "(none)"}`,
    d.config.store.mode === "local" ? "start the server: log out and in, or run `wscript //B <data>\\server\\start-hidden.js`" : "check `mema status`"));
  if (health?.min_client_version) {
    const [a, b] = CLIENT_VERSION.split(".").map(Number) as [number, number];
    const [c, e] = health.min_client_version.split(".").map(Number) as [number, number];
    out.push(a > c || (a === c && b >= e) ? pass("store.version", `client ${CLIENT_VERSION}, server ${health.version ?? "?"}`)
      : fail("store.version", `client ${CLIENT_VERSION} is older than ${health.min_client_version}`, "upgrade the client"));
  }
  if (d.config.store.mode === "local") {
    out.push(existsSync(d.paths.localTokenFile) ? pass("local.token", "present") : fail("local.token", "missing", "start the local server once; it writes the token"));
  } else if (d.store.url) {
    // A forced refresh proves the grant still works, not just that tokens.json exists.
    try {
      await accessToken(d.store.url, { paths: d.paths, fetch, now: d.now, sleep: d.sleep }, true);
      out.push(pass("auth.pc-grant", "token refresh works"));
    } catch (e) {
      out.push(fail("auth.pc-grant", (e as Error).message, "run `mema login`"));
    }
  }
  return out;
}

function claudeChecks(home: string): Check[] {
  const list = tool("claude", ["plugin", "list"]);
  if (list === undefined) return [warn("claude-code.plugin", "claude not found", "install Claude Code, then run `mema init`")];
  const out: Check[] = [];
  out.push(/memory-anywhere@memory-anywhere/u.test(list) ? pass("claude-code.plugin", "installed") : fail("claude-code.plugin", "not installed", "run `mema init --clients claude-code`"));
  const hooks = readJson(path.join(home, "hooks", "hooks.json"));
  const bundle = path.join(home, "dist", "memory-anywhere.mjs");
  out.push(hooks && existsSync(bundle) && JSON.stringify(hooks).includes("hook\",\"claude-code\",\"session-start") ? pass("claude-code.hooks", "both hooks point at the bundle")
    : fail("claude-code.hooks", "plugin hooks or bundle missing", "run `mema init --clients claude-code`"));
  const servers = (tool("claude", ["mcp", "list"]) ?? "").split("\n").filter((l) => /memory[- ]?anywhere/iu.test(l));
  const active = servers.filter((l) => !/blocked|disabled/iu.test(l));
  out.push(active.length <= 1 ? pass("claude-code.duplicate-connector", "tools appear once") : fail("claude-code.duplicate-connector", `${active.length} memory-anywhere servers are active`, "run `mema init --clients claude-code` to deny the claude.ai copy"));
  return out;
}

function codexChecks(t: ToolPaths): Check[] {
  if (!existsSync(t.codexConfigFile)) return [warn("codex.plugin", "no Codex config", "install Codex, then run `mema init --clients codex`")];
  const config = parseToml(readFileSync(t.codexConfigFile, "utf8")) as { plugins?: Record<string, { enabled?: boolean }>; hooks?: { state?: Record<string, { trusted_hash?: string }> } };
  const installed = config.plugins?.[`memory-anywhere@${CODEX_MARKET}`]?.enabled === true;
  const trusted = Object.entries(config.hooks?.state ?? {}).filter(([k, v]) => k.startsWith(`memory-anywhere@${CODEX_MARKET}`) && v.trusted_hash).length;
  return [
    installed ? pass("codex.plugin", "installed and enabled") : fail("codex.plugin", "not installed", "run `mema init --clients codex`"),
    trusted >= 2 ? pass("codex.hooks-trusted", "both hooks trusted") : warn("codex.hooks-trusted", `${trusted} of 2 hooks trusted`, "trust them in Codex: /hooks (CLI) or Settings → Hooks"),
  ];
}

function cursorChecks(t: ToolPaths): Check[] {
  const bundle = path.join(t.cursorPluginDir, "dist", "memory-anywhere.mjs");
  const plugin = existsSync(path.join(t.cursorPluginDir, "mcp.json")) && existsSync(bundle);
  const hooks = readJson(t.cursorHooksFile) as { hooks?: Record<string, { command: string }[]> } | undefined;
  const ours = ["sessionStart", "beforeSubmitPrompt"].every((e) => hooks?.hooks?.[e]?.some((c) => c.command.includes(bundle)));
  return [
    plugin ? pass("cursor.plugin", "present") : fail("cursor.plugin", "missing", "run `mema init --clients cursor`"),
    ours ? pass("cursor.hooks", "both hooks point at the plugin's bundle") : fail("cursor.hooks", "hooks missing or stale", "run `mema init --clients cursor`"),
  ];
}

function skillCheck(home: string): Check {
  const found = [".agents", ".claude", ".codex", ".cursor"].map((d) => path.join(home, d, "skills", "memory-anywhere", "SKILL.md")).filter((f) => existsSync(f));
  return found.length === 1 ? pass("skill.single", found[0] ?? "") : found.length === 0 ? fail("skill.single", "no skill installed", "run `mema init`")
    : warn("skill.single", `${found.length} copies: ${found.join(", ")}`, "keep only ~/.agents/skills/memory-anywhere");
}

/** Repo configs that define a memory-anywhere-like server (clients.md §3.2). */
function shadowCheck(roots: readonly string[]): Check {
  const files = roots.flatMap((r) => [".mcp.json", ".cursor/mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml"].map((f) => path.join(r, f)));
  const hits = files.filter((f) => existsSync(f) && /memory[-_ ]?anywhere|"mema"/iu.test(readFileSync(f, "utf8")));
  return hits.length === 0 ? pass("shadow-servers", `${roots.length} known repos clean`) : warn("shadow-servers", hits.join(", "), "remove those server entries; disabledMcpjsonServers already hides a project .mcp.json in Claude Code");
}

/** Hook configs that mention memory-anywhere but were not installed by this client. */
function foreignHooksCheck(home: string, t: ToolPaths): Check {
  const candidates = [path.join(home, ".claude", "settings.json"), path.join(t.codexHome, "hooks.json")];
  const hits = candidates.filter((f) => existsSync(f) && /\bmema\b|memory-anywhere/iu.test(JSON.stringify(readJson(f)?.["hooks"] ?? "")));
  return hits.length === 0 ? pass("foreign-hooks", "none") : warn("foreign-hooks", hits.join(", "), "remove memory-anywhere hooks there; the plugins carry their own");
}

export async function runChecks(d: CommandDeps, home = os.homedir(), t: ToolPaths = currentToolPaths()): Promise<Check[]> {
  const checks = await storeChecks(d);
  checks.push(...claudeChecks(installDirs(d.paths).claudePlugin), ...codexChecks(t), ...cursorChecks(t), skillCheck(home));
  const repos = Object.entries(readRepos(d.paths));
  checks.push(shadowCheck(repos.map(([, s]) => s.root).filter((r): r is string => typeof r === "string")), foreignHooksCheck(home, t));
  const enabled = repos.filter(([, s]) => s.enabled).length;
  checks.push(pass("repos.enabled", `${enabled} enabled; deny-list: ${d.config.repos.deny_remotes.join(", ") || "(empty)"}`));
  const spool = spoolStats(d.paths);
  const ageDays = spool.oldestMs ? (d.now() - spool.oldestMs) / 86_400_000 : 0;
  const full = spool.bytes / d.config.spool.max_bytes > 0.8 || ageDays / d.config.spool.max_age_days > 0.8;
  checks.push(full ? warn("spool", `${spool.count} entries, ${spool.bytes} bytes`, "run `mema sync` while the store is reachable") : pass("spool", `${spool.count} waiting`));
  const profile = readProfile(d.paths);
  const fresh = profile && d.now() - Date.parse(profile.generatedAt) < 86_400_000;
  checks.push(fresh ? pass("caches", "fresh") : warn("caches", profile ? "older than 24 h" : "no profile cache yet", "run `mema sync`"));
  const unknown = loadClientConfig(d.paths).unknownKeys;
  if (unknown.length > 0) checks.push(warn("client.config", `unknown keys: ${unknown.join(", ")}`, "they are ignored; remove them or upgrade"));
  return checks;
}

export async function doctor(d: CommandDeps): Promise<boolean> {
  const checks = await runChecks(d);
  for (const c of checks) {
    d.out(`${c.verdict.padEnd(4)}  ${c.id.padEnd(32)}  ${c.detail}`);
    if (c.fix) d.out(`      ${"".padEnd(32)}  fix: ${c.fix}`);
  }
  return checks.every((c) => c.verdict !== "fail");
}
