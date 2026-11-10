// Local mode's server lifecycle (topology-and-ipc.md §4; spec-issues #22): `mema init --local`
// writes server.toml, runs the server's own `init` (store + model), registers a per-user logon
// task that starts the server with no window, and starts it at once. No admin rights are needed.
//
//   Windows  Task Scheduler, at logon of this user, conhost --headless node … start --local
//   macOS    ~/Library/LaunchAgents/dev.memory-anywhere.server.plist (RunAtLoad, KeepAlive)
//   Linux    ~/.config/systemd/user/memory-anywhere.service (WantedBy=default.target)
//
// Every command is run with an argv array; paths with spaces are never re-quoted by a shell.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
 * PowerShell for the Windows logon task. The values arrive in environment variables, so no path
 * is ever spliced into the script text.
 */
export const WINDOWS_TASK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$user = \"$env:USERDOMAIN\\$env:USERNAME\"",
  "$argline = ($env:MA_TASK_ARGS | ConvertFrom-Json | ForEach-Object { '\"' + $_ + '\"' }) -join ' '",
  "$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless ' + $argline)",
  "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
  "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
  "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
  "Register-ScheduledTask -TaskName $env:MA_TASK_NAME -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
  "Start-ScheduledTask -TaskName $env:MA_TASK_NAME",
].join("; ");

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

/** Registers the logon task and starts the server now. Throws with the tool's message on failure. */
export function registerAndStart(argv: readonly string[], runner: Runner = run, platform: NodeJS.Platform = process.platform, home = os.homedir()): void {
  if (platform === "win32") {
    const r = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TASK_SCRIPT], { MA_TASK_NAME: TASK_NAME, MA_TASK_ARGS: JSON.stringify(argv) });
    if (r.status !== 0) throw new Error(`could not register the logon task: ${r.stderr.trim() || r.stdout.trim()}`);
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
