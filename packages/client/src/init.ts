// `mema init [--local] --from-workspace <path>` (config-and-cli.md §4.1; clients.md §6): sets up
// this PC from a checkout of the repository, for the local server or for a remote store.
//
//   1 build the checkout (client bundle, plugin dist/)        local mode            remote store
//   2 client.toml (+ server.toml), backed up and diffed       3 the server's init   3 leave local mode, if on
//   6 install each detected coding tool                       4 the logon task      4 check /v1/health
//   7 the standalone skill                                    5 wait for health     5 mema login (PC grant)
//   8 the repo deny-list; 9 next steps, then doctor
//
// `--dry-run` prints every diff and command and changes nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentToolPaths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir } from "@memory-anywhere/contracts/secure-fs";
import os from "node:os";
import type { CommandDeps } from "./commands.ts";
import { leaveLocalMode, printCustomInstruction } from "./commands.ts";
import { login as pcLogin, readTokens } from "./auth.ts";
import { clientToml, LOCAL_URL } from "./config.ts";
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

/** The remote store's URL: client.toml's, else asked for. Must be https. */
async function remoteUrl(d: CommandDeps): Promise<string> {
  const configured = d.config.store.mode === "remote" ? d.config.store.url : "";
  const url = (configured || (await d.ask("Your store's URL (for example https://memory.example.com):", ""))).replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(url)) throw new Error(`a remote store needs an https origin, not "${url}"`);
  return url;
}

export async function init(d: CommandDeps, o: InitOptions): Promise<void> {
  if (!o.fromWorkspace) throw new Error("--from-workspace <path> is required until release builds exist");
  const workspace = path.resolve(o.fromWorkspace);
  const serverCli = workspaceServerCli(workspace);
  if (!existsSync(serverCli)) throw new Error(`${workspace} is not a memory-anywhere checkout (no packages/server/src/cli.ts)`);
  const toolPaths = currentToolPaths();
  const home = path.dirname(path.dirname(toolPaths.claudeSettingsFile));
  const tools = selectTools(o.clients, home);
  const storeUrl = o.local ? LOCAL_URL : await remoteUrl(d);

  d.out(o.local ? `memory-anywhere local mode, from ${workspace}` : `memory-anywhere with your store at ${storeUrl}, from ${workspace}`);
  d.out(`coding tools found: ${tools.join(", ") || "none"}`);
  d.out(o.local ? "Everything stays on this PC: the store, the model, and a token readable only by you."
    : "Your memories live in your store. This PC keeps a sign-in token readable only by you, caches and a spool.");
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
  // --yes keeps the current deny-list (edit client.toml [repos] deny_remotes later); otherwise ask.
  const denyRemotes = o.dryRun || o.yes ? d.config.repos.deny_remotes : await askDenyList(d);
  const configPlan: InstallPlan = {
    tool: "skill",
    files: [
      ...fileChange(d.paths.clientConfigFile, clientToml(o.local ? "local" : "remote", storeUrl, denyRemotes)),
      ...(o.local ? fileChange(d.paths.localServerConfigFile, serverToml(d.paths)) : []),
    ],
    folders: [], commands: [], notes: [],
  };
  const claudeServers = tools.includes("claude-code") ? (runTool("claude", ["mcp", "list"], 30_000).stdout.split("\n").map((l) => l.split(":")[0]?.trim() ?? "").filter(Boolean)) : [];
  const inputs = { paths: d.paths, tools: toolPaths, pluginsDir, claudeServers };
  const plans: InstallPlan[] = [
    configPlan,
    ...tools.map((t) => (t === "claude-code" ? planClaudeCode(inputs) : t === "codex" ? planCodex(inputs, bundle) : planCursor(inputs))),
    planSkill(toolPaths),
  ];
  for (const p of plans) d.out(describePlan(p));
  if (o.dryRun) {
    d.out(o.local ? `dry run: would run the server's init, register the logon task and start ${serverArgv(serverCli, d.paths.localServerConfigFile).join(" ")}`
      : `dry run: would ${d.config.store.mode === "local" ? "leave local mode, " : ""}check ${storeUrl}/v1/health and sign this PC in`);
    return;
  }

  ensurePrivateDir(d.paths.dataDir);
  ensurePrivateDir(path.dirname(d.paths.clientConfigFile));
  const problems = applyPlan(configPlan, { run: (c, a) => runTool(c, a), now: d.now });

  if (o.local) {
    // 3–5. Server: store and model, logon task, health.
    await serverInit(serverCli, d.paths.localServerConfigFile);
    registerAndStart(serverArgv(serverCli, d.paths.localServerConfigFile), path.join(d.paths.localServerDataDir, "start-hidden.js"));
    if (!(await waitHealthy(LOCAL_URL, 60_000))) throw new Error("the local server did not become healthy within 60 s; see `mema doctor`");
    d.out(`server running at ${LOCAL_URL}`);
  } else {
    // 3–5. Leave local mode, check the store, sign in (unless already signed in to it).
    if (d.config.store.mode === "local") leaveLocalMode(d);
    if (!(await waitHealthy(storeUrl, 10_000))) throw new Error(`${storeUrl} does not answer /v1/health; check the URL and \`mema deploy\``);
    if (readTokens(d.paths)?.issuer !== storeUrl) {
      await pcLogin(storeUrl, { paths: d.paths, fetch, now: d.now, sleep: d.sleep }, { out: d.out, openBrowser: d.openBrowser, machineName: os.hostname() });
    }
    d.out(`signed in to ${storeUrl}`);
  }

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
