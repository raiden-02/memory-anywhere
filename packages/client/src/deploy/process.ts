// Child processes for the deploy commands: always an argument array, never a
// shell, so paths with spaces and owner values are passed through untouched.

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Stream output to the terminal instead of capturing it (cdk deploy, cdk diff). */
  inherit?: boolean;
  /** Extra environment variables, added to this process's environment. */
  env?: Record<string, string>;
}

export type Runner = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const runProcess: Runner = (command, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: ["inherit", opts.inherit ? "inherit" : "pipe", opts.inherit ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => reject(new Error(`could not start ${command}: ${e.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });

/** Run and require exit 0. */
export async function must(run: Runner, what: string, command: string, args: string[], opts?: RunOptions): Promise<string> {
  const r = await run(command, args, opts);
  if (r.code !== 0) throw new DeployError(`${what} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return r.stdout;
}

/** A refusal or failure with a message meant for the owner. */
export class DeployError extends Error {
  override name = "DeployError";
}
