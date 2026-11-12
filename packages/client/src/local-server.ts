// Local mode's server lifecycle (topology-and-ipc.md §4; spec-issues #22, #48): `mema init --local`
// writes server.toml, runs the server's own `init` (store + model), registers a per-user start at
// logon with no window, and starts the server at once. No admin rights are needed.
//
//   Windows  HKCU\…\Run "memory-anywhere server": wscript runs {data}\server\start-hidden.js, which
//            starts node … start --local with a hidden window, waits, and retries a crash 3 times
//            (an at-logon Task Scheduler task needs admin rights)
//   macOS    ~/Library/LaunchAgents/dev.memory-anywhere.server.plist (RunAtLoad, KeepAlive)
//   Linux    ~/.config/systemd/user/memory-anywhere.service (WantedBy=default.target)
//
// Every command is run with an argv array; paths with spaces are never re-quoted by a shell.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { LOCAL_URL } from "./config.ts";

export const TASK_NAME = "memory-anywhere server";
const LAUNCH_LABEL = "dev.memory-anywhere.server";

/** The server entry point inside a workspace checkout (`--from-workspace`). */
export const workspaceServerCli = (workspace: string): string => path.join(path.resolve(workspace), "packages", "server", "src", "cli.ts");

export function serverToml(paths: Paths): string {
  const q = (s: string): string => JSON.stringify(s);
  return [
    "schema = 1",
    "",
    "[server]",
    'mode = "local"',
    `listen = "${new URL(LOCAL_URL).host}"`,
    `data_dir = ${q(paths.localServerDataDir)}`,
    `local_token_file = ${q(paths.localTokenFile)}`,
    `models_dir = ${q(paths.modelsDir)}`,
    "",
  ].join("\n");
}

/** argv of the long-running server. */
export const serverArgv = (serverCli: string, configFile: string): string[] => [process.execPath, serverCli, "start", "--local", "--config", configFile];

export interface Runner {
  (command: string, args: readonly string[], env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string };
}

export const run: Runner = (command, args, env) => {
  const r = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
};

/**
 * The Windows launcher: a Windows Script Host file that runs the server with a hidden window and
 * waits for it. A crash (non-zero exit) is retried up to 3 times, a minute apart; a clean stop
 * ends it. Starting node directly would open a console window at every logon, and
 * `conhost --headless` exits at once when not started from a console (spec-issues #45). Written
 * as UTF-16 so any path survives.
 */
export function windowsLauncher(argv: readonly string[]): Buffer {
  const commandLine = argv.map((a) => `"${a}"`).join(" ");
  const text = [
    "// memory-anywhere: starts the local server with no window (written by mema init).",
    'var shell = new ActiveXObject("WScript.Shell");',
    "var code = 0;",
    "for (var attempt = 0; attempt < 4; attempt++) {",
    `  code = shell.Run(${JSON.stringify(commandLine)}, 0, true);`,
    "  if (code === 0) break;",
    "  if (attempt < 3) WScript.Sleep(60000);",
    "}",
    "WScript.Quit(code);",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** The per-user Run key that starts the launcher at logon. */
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** The Run value's command: wscript in batch mode on the launcher. */
export const runValue = (launcherFile: string): string => `wscript.exe //B //Nologo "${launcherFile}"`;

export function launchAgentPlist(argv: readonly string[]): string {
  const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function systemdUnit(argv: readonly string[]): string {
  const quote = (a: string): string => `"${a.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `[Unit]
Description=memory-anywhere local server

[Service]
ExecStart=${argv.map(quote).join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Starts a process that outlives this one, with no window and no inherited handles. */
export type Detached = (command: string, args: readonly string[]) => void;

export const detached: Detached = (command, args) => {
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
};

/**
 * Registers the start at logon and starts the server now. Throws with the tool's message on
 * failure. `launcherFile` is where Windows keeps its launcher (`{data}\server\start-hidden.js`).
 */
export function registerAndStart(
  argv: readonly string[], launcherFile: string, runner: Runner = run, platform: NodeJS.Platform = process.platform, home = os.homedir(), start: Detached = detached,
): void {
  if (platform === "win32") {
    mkdirSync(path.dirname(launcherFile), { recursive: true });
    writeFileSync(launcherFile, windowsLauncher(argv));
    const r = runner("reg.exe", ["add", RUN_KEY, "/v", TASK_NAME, "/t", "REG_SZ", "/d", runValue(launcherFile), "/f"]);
    if (r.status !== 0) throw new Error(`could not register the start at logon: ${r.stderr.trim() || r.stdout.trim()}`);
    start("wscript.exe", ["//B", "//Nologo", launcherFile]);
    return;
  }
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, launchAgentPlist(argv));
    runner("launchctl", ["unload", file]);
    const r = runner("launchctl", ["load", "-w", file]);
    if (r.status !== 0) throw new Error(`launchctl load failed: ${r.stderr.trim()}`);
    return;
  }
  const file = path.join(home, ".config", "systemd", "user", "memory-anywhere.service");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit(argv));
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", "memory-anywhere.service"]]) {
    const r = runner("systemctl", args);
    if (r.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
}

/** A PowerShell single-quoted literal: quotes doubled, nothing else expands. */
const psLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * Leaving local mode (`mema connect` to a remote store): removes the start at logon and stops the
 * running server. On Windows the launcher goes first, since it restarts a server that exits with an
 * error. The local store stays on disk as a backup; nothing here deletes it.
 */
export function unregisterAndStop(launcherFile: string, configFile: string, runner: Runner = run, platform: NodeJS.Platform = process.platform, home = os.homedir()): void {
  if (platform === "win32") {
    runner("reg.exe", ["delete", RUN_KEY, "/v", TASK_NAME, "/f"]);
    const match = (needle: string) => `$_.CommandLine.Contains(${psLiteral(needle)})`;
    const script = [
      "$all = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine };",
      `$all | Where-Object { ${match(launcherFile)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };`,
      `$all | Where-Object { ${match(configFile)} -and $_.CommandLine.Contains(' start ') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ].join(" ");
    const r = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (r.status !== 0) throw new Error(`could not stop the local server: ${r.stderr.trim() || r.stdout.trim()}`);
    return;
  }
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
    runner("launchctl", ["unload", "-w", file]);
    rmSync(file, { force: true });
    return;
  }
  runner("systemctl", ["--user", "disable", "--now", "memory-anywhere.service"]);
  rmSync(path.join(home, ".config", "systemd", "user", "memory-anywhere.service"), { force: true });
}

/** Runs the server's own `init` (store, meta keys, model download), streaming its progress. */
export function serverInit(serverCli: string, configFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverCli, "init", "--config", configFile], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`memory-anywhere-server init exited with ${code}`))));
  });
}

/** Polls /v1/health until it answers ok or the time runs out. */
export async function waitHealthy(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetchImpl(`${url}/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && ((await r.json()) as { ok?: boolean }).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
