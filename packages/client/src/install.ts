// What `mema init` installs for each coding tool (clients.md §3, §6; ADR-0109, ADR-0110), as a
// plan: files to write (each backed up and shown as a diff first), folders to copy, and tool
// commands to run. Planning reads only; `applyPlan` writes.
//
//   Claude Code  plugin folder → `claude plugin marketplace add` + `claude plugin install … --scope user`;
//                ~/.claude/settings.json: disabledMcpjsonServers (and deniedMcpServers for a claude.ai copy)
//   Codex        local marketplace with the legacy .codex-plugin layout → `codex plugin marketplace add` +
//                `codex plugin add`; ~/.codex/config.toml [mcp_servers] for the IDE extension; owner trusts hooks
//   Cursor       plugin copied to ~/.cursor/plugins/local/memory-anywhere/ (MCP + rule);
//                ~/.cursor/hooks.json for the hooks (Cursor runs no plugin hooks), bundle under ~/.cursor
//   all          the standalone skill at ~/.agents/skills/memory-anywhere/SKILL.md

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Paths, ToolPaths } from "@memory-anywhere/contracts/paths";
import { CLIENT_TEXTS } from "@memory-anywhere/contracts/policy-data";
import { CLIENT_VERSION } from "./config.ts";
import { unifiedDiff } from "./diff.ts";

export type InstallTool = "claude-code" | "codex" | "cursor";
export const INSTALL_TOOLS: readonly InstallTool[] = ["claude-code", "codex", "cursor"];

export interface FileChange {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string;
}

export interface FolderCopy {
  readonly from: string;
  readonly to: string;
}

export interface ToolCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Output that means "already done" rather than failure. */
  readonly okIfOutputMatches?: RegExp;
}

export interface InstallPlan {
  readonly tool: InstallTool | "skill";
  readonly files: readonly FileChange[];
  readonly folders: readonly FolderCopy[];
  readonly commands: readonly ToolCommand[];
  /** What the owner must still do (trust hooks, reload a window). */
  readonly notes: readonly string[];
}

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function change(file: string, after: string): FileChange[] {
  const before = read(file);
  return before === after ? [] : [{ path: file, before, after }];
}

/** Where init keeps the installed plugin copies and the stable bundle the Codex hooks call. */
export const installDirs = (p: Paths) => ({
  claudePlugin: path.join(p.dataDir, "plugins", "claude-code"),
  codexMarket: path.join(p.dataDir, "plugins", "codex-marketplace"),
  /** Codex hashes the hook command for trust; a fixed bundle path keeps trust across upgrades. */
  stableBundle: path.join(p.dataDir, "bin", "memory-anywhere.mjs"),
});

export const CODEX_MARKET = "memory-anywhere-local";

export interface PlanInputs {
  readonly paths: Paths;
  readonly tools: ToolPaths;
  /** The checkout's plugins/ folder, after `pnpm build`. */
  readonly pluginsDir: string;
  /** Server names already configured in Claude Code (from `claude mcp list`). */
  readonly claudeServers: readonly string[];
}

export function planSkill(t: ToolPaths): InstallPlan {
  return { tool: "skill", files: change(t.agentsSkillFile, `${CLIENT_TEXTS.skill}\n`), folders: [], commands: [], notes: [] };
}

export function planClaudeCode(i: PlanInputs): InstallPlan {
  const dirs = installDirs(i.paths);
  const settingsFile = i.tools.claudeSettingsFile;
  const settings = JSON.parse(read(settingsFile) ?? "{}") as Record<string, unknown>;
  const disabled = new Set((settings["disabledMcpjsonServers"] as string[] | undefined) ?? []);
  disabled.add("memory-anywhere");
  // A claude.ai connector named like memory-anywhere would load next to the plugin (ADR-0105).
  const connector = i.claudeServers.find((s) => /^claude\.ai .*memory[- ]?anywhere/iu.test(s));
  const denied = [...((settings["deniedMcpServers"] as { serverName: string }[] | undefined) ?? [])];
  if (connector && !denied.some((d) => d.serverName === connector)) denied.push({ serverName: connector });
  const next = { ...settings, disabledMcpjsonServers: [...disabled], ...(denied.length > 0 ? { deniedMcpServers: denied } : {}) };
  return {
    tool: "claude-code",
    files: change(settingsFile, json(next)),
    folders: [{ from: path.join(i.pluginsDir, "claude-code"), to: dirs.claudePlugin }],
    commands: [
      { command: "claude", args: ["plugin", "marketplace", "add", dirs.claudePlugin], okIfOutputMatches: /already/iu },
      { command: "claude", args: ["plugin", "marketplace", "update", "memory-anywhere"] },
      { command: "claude", args: ["plugin", "install", "memory-anywhere@memory-anywhere", "--scope", "user"], okIfOutputMatches: /already/iu },
      { command: "claude", args: ["plugin", "update", "memory-anywhere@memory-anywhere", "--scope", "user"], okIfOutputMatches: /latest|up to date|already/iu },
    ],
    notes: connector ? [`Claude Code will report the claude.ai connector "${connector}" as blocked by policy: that is intended, so the tools load once.`] : [],
  };
}

const hookCommand = (bundle: string, tool: string, event: string): string => `node "${bundle}" hook ${tool} ${event}`;

export function codexPluginManifest(bundle: string): Record<string, unknown> {
  const hook = (event: string) => [{ type: "command", command: hookCommand(bundle, "codex", event), commandWindows: hookCommand(bundle, "codex", event), timeout: 5 }];
  return {
    name: "memory-anywhere",
    version: CLIENT_VERSION,
    description: "Personal memory across AI apps",
    mcpServers: "./.mcp.json",
    hooks: { hooks: { SessionStart: [{ matcher: "startup|resume", hooks: hook("session-start") }], UserPromptSubmit: [{ hooks: hook("prompt") }] } },
  };
}

export function planCodex(i: PlanInputs, bundleSource: string): InstallPlan {
  const dirs = installDirs(i.paths);
  const plugin = path.join(dirs.codexMarket, "plugins", "memory-anywhere");
  const mcpArgs = [dirs.stableBundle, "mcp", "--tool", "codex"];
  const configFile = i.tools.codexConfigFile;
  const config = read(configFile) ?? "";
  const hasServer = config !== "" && (parseToml(config) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.["memory-anywhere"] !== undefined;
  const block = `\n[mcp_servers.memory-anywhere]\ncommand = "node"\nargs = ${JSON.stringify(mcpArgs)}\n`;
  return {
    tool: "codex",
    files: [
      ...change(path.join(dirs.codexMarket, ".agents", "plugins", "marketplace.json"), json({
        name: CODEX_MARKET,
        plugins: [{ name: "memory-anywhere", source: { source: "local", path: "./plugins/memory-anywhere" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
      })),
      ...change(path.join(plugin, ".codex-plugin", "plugin.json"), json(codexPluginManifest(dirs.stableBundle))),
      ...change(path.join(plugin, ".mcp.json"), json({ mcpServers: { "memory-anywhere": { type: "stdio", command: "node", args: mcpArgs } } })),
      ...(hasServer ? [] : change(configFile, `${config.trimEnd()}${config ? "\n" : ""}${block}`)),
    ],
    folders: [{ from: bundleSource, to: dirs.stableBundle }],
    commands: [
      { command: "codex", args: ["plugin", "marketplace", "add", dirs.codexMarket], okIfOutputMatches: /already/iu },
      { command: "codex", args: ["plugin", "add", `memory-anywhere@${CODEX_MARKET}`], okIfOutputMatches: /already/iu },
    ],
    notes: ["Codex: trust the two memory-anywhere hooks once in /hooks (CLI) or Settings → Hooks (desktop); Codex skips untrusted hooks silently."],
  };
}

export function planCursor(i: PlanInputs): InstallPlan {
  const dir = i.tools.cursorPluginDir;
  const bundle = path.join(dir, "dist", "memory-anywhere.mjs");
  const hooksFile = i.tools.cursorHooksFile;
  const existing = JSON.parse(read(hooksFile) ?? '{"version":1,"hooks":{}}') as { version?: number; hooks?: Record<string, { command: string }[]> };
  const ours = (c: { command: string }): boolean => /memory-anywhere\.mjs"? hook cursor/u.test(c.command);
  const hooks = { ...(existing.hooks ?? {}) };
  for (const event of ["sessionStart", "beforeSubmitPrompt"]) hooks[event] = [...(hooks[event] ?? []).filter((c) => !ours(c)), { command: hookCommand(bundle, "cursor", event) }];
  return {
    tool: "cursor",
    files: [
      ...change(path.join(dir, "mcp.json"), json({ mcpServers: { "memory-anywhere": { command: "node", args: [bundle, "mcp", "--tool", "cursor"] } } })),
      ...change(hooksFile, json({ ...existing, version: 1, hooks })),
    ],
    folders: [{ from: path.join(i.pluginsDir, "cursor"), to: dir }],
    commands: [],
    notes: ["Cursor: run Developer: Reload Window so the plugin and the hooks load."],
  };
}

/** The diff of every file the plan changes, as the owner will see it. */
export function describePlan(plan: InstallPlan): string {
  const parts = [`# ${plan.tool}`];
  for (const f of plan.folders) parts.push(`copy ${f.from} → ${f.to}`);
  for (const f of plan.files) parts.push(unifiedDiff(f.path, f.before ?? "", f.after).trimEnd());
  for (const c of plan.commands) parts.push(`run ${c.command} ${c.args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  return parts.join("\n");
}

export interface ApplyDeps {
  readonly run: (command: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  readonly now: () => number;
}

/** Copies folders, backs up and writes files, then runs the tool commands. Returns problems found. */
export function applyPlan(plan: InstallPlan, deps: ApplyDeps): string[] {
  const problems: string[] = [];
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/gu, "-");
  for (const f of plan.folders) {
    mkdirSync(path.dirname(f.to), { recursive: true });
    if (f.from.endsWith(".mjs")) copyFileSync(f.from, f.to);
    else cpSync(f.from, f.to, { recursive: true, force: true });
  }
  for (const f of plan.files) {
    mkdirSync(path.dirname(f.path), { recursive: true });
    if (f.before !== undefined) writeFileSync(`${f.path}.ma-bak-${stamp}`, f.before);
    writeFileSync(f.path, f.after);
  }
  for (const c of plan.commands) {
    const r = deps.run(c.command, c.args);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0 && !(c.okIfOutputMatches?.test(text) ?? false)) problems.push(`${c.command} ${c.args.join(" ")}: ${text.trim().split("\n").at(-1) ?? `exit ${r.status}`}`);
  }
  return problems;
}
