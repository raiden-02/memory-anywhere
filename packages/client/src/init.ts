// `mema init --local --from-workspace <path>` (config-and-cli.md §4.1; clients.md §6): sets up
// local mode on this PC from a checkout of the repository.
//
//   1 build the checkout (client bundle, plugin dist/)        6 install each detected coding tool
//   2 client.toml and server.toml (backed up, diffed)         7 the standalone skill
//   3 the server's init: store and model (Gemma terms shown)   8 the repo deny-list
//   4 the logon task, server started now                      9 next steps, then doctor
//   5 wait for /v1/health
//
// `--dry-run` prints every diff and command and changes nothing. Remote mode (an AWS store and the
// PC grant) arrives in M2.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentToolPaths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir } from "@memory-anywhere/contracts/secure-fs";
import type { CommandDeps } from "./commands.ts";
import { printCustomInstruction } from "./commands.ts";
import { LOCAL_URL, localClientToml } from "./config.ts";
import { doctor } from "./doctor.ts";
import { applyPlan, describePlan, INSTALL_TOOLS, planClaudeCode, planCodex, planCursor, planSkill, type InstallPlan, type InstallTool } from "./install.ts";
import { registerAndStart, serverArgv, serverInit, serverToml, waitHealthy, workspaceServerCli } from "./local-server.ts";
import { resolveTool, runTool } from "./tool-runner.ts";

export interface InitOptions {
  readonly local: boolean;
  readonly fromWorkspace: string | undefined;
  readonly clients: string | undefined;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

const fileChange = (file: string, after: string) => {
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  return before === after ? [] : [{ path: file, before, after }];
};

/** Tools to set up: the --clients list, else every detected one. */
function selectTools(clients: string | undefined, home: string): InstallTool[] {
  const wanted = clients ? clients.split(",").map((s) => s.trim()) : [...INSTALL_TOOLS];
  for (const w of wanted) if (!INSTALL_TOOLS.includes(w as InstallTool)) throw new Error(`unknown client ${w}; use ${INSTALL_TOOLS.join(",")}`);
  const detected: Record<InstallTool, boolean> = {
    "claude-code": resolveTool("claude") !== undefined,
    codex: resolveTool("codex") !== undefined,
    cursor: resolveTool("cursor") !== undefined || existsSync(path.join(home, ".cursor")),
  };
  return (wanted as InstallTool[]).filter((t) => detected[t]);
}

export async function init(d: CommandDeps, o: InitOptions): Promise<void> {
  if (!o.local) throw new Error("only local mode can be set up so far: mema init --local --from-workspace <path to the memory-anywhere checkout>");
  if (!o.fromWorkspace) throw new Error("--from-workspace <path> is required until release builds exist");
  const workspace = path.resolve(o.fromWorkspace);
  const serverCli = workspaceServerCli(workspace);
  if (!existsSync(serverCli)) throw new Error(`${workspace} is not a memory-anywhere checkout (no packages/server/src/cli.ts)`);
  const toolPaths = currentToolPaths();
  const home = path.dirname(path.dirname(toolPaths.claudeSettingsFile));
  const tools = selectTools(o.clients, home);

  d.out(`memory-anywhere local mode, from ${workspace}`);
  d.out(`coding tools found: ${tools.join(", ") || "none"}`);
  d.out("Everything stays on this PC: the store, the model, and a token readable only by you.");
  if (!o.dryRun && !o.yes && !/^y(es)?$/iu.test(await d.ask("Continue? [y/N]", "n"))) throw new Error("cancelled");

  // 1. Build: the client bundle and each plugin's dist/.
  if (!o.dryRun) {
    d.out("building the client bundle…");
    const b = spawnSync(process.execPath, [path.join(workspace, "scripts", "build.ts")], { cwd: workspace, encoding: "utf8", windowsHide: true });
    if (b.status !== 0) throw new Error(`build failed: ${(b.stderr || b.stdout).trim()}`);
  }
  const pluginsDir = path.join(workspace, "plugins");
  const bundle = path.join(workspace, "packages", "client", "dist", "memory-anywhere.mjs");

  // 2. Config files.
  const denyRemotes = o.dryRun ? d.config.repos.deny_remotes : await askDenyList(d);
  const configPlan: InstallPlan = {
    tool: "skill",
    files: [...fileChange(d.paths.clientConfigFile, localClientToml(denyRemotes)), ...fileChange(d.paths.localServerConfigFile, serverToml(d.paths))],
    folders: [], commands: [], notes: [],
  };
  const claudeServers = tools.includes("claude-code") ? (runTool("claude", ["mcp", "list"], 30_000).stdout.split("\n").map((l) => l.split(":")[0]?.trim() ?? "").filter(Boolean)) : [];
  const inputs = { paths: d.paths, tools: toolPaths, pluginsDir, claudeServers };
  const plans: InstallPlan[] = [
    { ...configPlan, tool: "skill" },
    ...tools.map((t) => (t === "claude-code" ? planClaudeCode(inputs) : t === "codex" ? planCodex(inputs, bundle) : planCursor(inputs))),
    planSkill(toolPaths),
  ];
  for (const p of plans) d.out(describePlan(p));
  if (o.dryRun) {
    d.out(`dry run: would run the server's init, register the logon task and start ${serverArgv(serverCli, d.paths.localServerConfigFile).join(" ")}`);
    return;
  }

  ensurePrivateDir(d.paths.dataDir);
  ensurePrivateDir(path.dirname(d.paths.clientConfigFile));
  const problems = applyPlan(plans[0] as InstallPlan, { run: (c, a) => runTool(c, a), now: d.now });

  // 3–5. Server: store and model, logon task, health.
  await serverInit(serverCli, d.paths.localServerConfigFile);
  registerAndStart(serverArgv(serverCli, d.paths.localServerConfigFile));
  if (!(await waitHealthy(LOCAL_URL, 60_000))) throw new Error("the local server did not become healthy within 60 s; see `mema doctor`");
  d.out(`server running at ${LOCAL_URL}`);

  // 6–7. Coding tools and the skill.
  for (const p of plans.slice(1)) problems.push(...applyPlan(p, { run: (c, a) => runTool(c, a), now: d.now }));
  for (const p of problems) d.out(`problem: ${p}`);

  // 9. What is left for the owner.
  for (const note of plans.flatMap((p) => p.notes)) d.out(`next: ${note}`);
  d.out("next: in each repository where memory should work, run `mema enable`.");
  d.out("");
  printCustomInstruction(d);
  d.out("");
  await doctor(d);
}

async function askDenyList(d: CommandDeps): Promise<string[]> {
  const current = d.config.repos.deny_remotes;
  const answer = await d.ask(`Git hosts or host/path prefixes where memory must never be used (for example an employer's), comma-separated [${current.join(", ")}]:`, current.join(","));
  return answer.split(",").map((s) => s.trim()).filter(Boolean);
}
