// Running other programs, always with an argv array and never a shell string, so paths with spaces
// pass through untouched: `runCommand` for a program by path or system name, `runTool` for the
// coding tools' own CLIs (`claude`, `codex`). On Windows a tool installed by npm is a `.cmd` shim
// that only a shell can start; the shim names the JavaScript file it runs, so that file is run with
// this Node instead.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface ToolResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** The executable and leading arguments that start `name`, or undefined if it is not installed. */
export function resolveTool(
	name: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; prefix: string[] } | undefined {
	if (platform !== "win32") {
		const r = spawnSync("which", [name], { encoding: "utf8" });
		return r.status === 0 ? { command: r.stdout.trim().split("\n")[0] ?? name, prefix: [] } : undefined;
	}
	const r = spawnSync(path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "where.exe"), [name], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (r.status !== 0) return undefined;
	const found = r.stdout.split(/\r?\n/u).filter(Boolean);
	const exe = found.find((f) => f.toLowerCase().endsWith(".exe"));
	if (exe) return { command: exe, prefix: [] };
	const shim = found.find((f) => f.toLowerCase().endsWith(".cmd"));
	if (!shim) return undefined;
	const script = /"%(?:~?dp0)%\\([^"]+\.(?:c|m)?js)"/iu.exec(readFileSync(shim, "utf8"))?.[1];
	return script ? { command: process.execPath, prefix: [path.join(path.dirname(shim), script)] } : undefined;
}

/** Runs `command` and waits; `env` adds to this process's environment. */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): ToolResult {
	const r = spawnSync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
		...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

export function runTool(name: string, args: readonly string[], timeoutMs = 120_000): ToolResult {
	const t = resolveTool(name);
	if (!t) return { status: null, stdout: "", stderr: `${name} is not installed` };
	return runCommand(t.command, [...t.prefix, ...args], { timeoutMs });
}
