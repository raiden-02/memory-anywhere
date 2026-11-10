// Private files and atomic writes, shared by client and server.
//
// - User-only ACLs (config-and-cli.md §3, topology-and-ipc.md §4): on Windows `icacls` removes
//   inherited entries and grants only the current user; elsewhere the mode is 0700 / 0600.
// - Atomic writes (topology-and-ipc.md §6, §9): write `<target>.tmp-<pid>`, then rename, which
//   replaces the target in one step on NTFS and POSIX.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Restricts `target` to the current user. Throws if the ACL cannot be set. */
export function restrictToUser(target: string, kind: "file" | "dir"): void {
  if (process.platform !== "win32") {
    chmodSync(target, kind === "dir" ? 0o700 : 0o600);
    return;
  }
  const user = os.userInfo().username;
  const grant = kind === "dir" ? `${user}:(OI)(CI)F` : `${user}:F`;
  const icacls = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  const r = spawnSync(icacls, [target, "/inheritance:r", "/grant:r", grant], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`icacls could not restrict ${target}: ${(r.stderr || r.stdout || String(r.error)).trim()}`);
  }
}

/** Creates `dir` (and parents) if missing; a newly created leaf directory is made user-only. */
export function ensurePrivateDir(dir: string): void {
  const created = mkdirSync(dir, { recursive: true });
  if (created !== undefined) restrictToUser(dir, "dir");
}

/** Writes `text` to `target` atomically. `private` restricts the file to the current user. */
export function writeFileAtomic(target: string, text: string | Uint8Array, options: { private?: boolean } = {}): void {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, options.private ? { mode: 0o600 } : undefined);
    if (options.private) restrictToUser(tmp, "file");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
