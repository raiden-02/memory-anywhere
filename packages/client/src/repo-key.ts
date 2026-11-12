// The repo key (topology-and-ipc.md §8): a repository's identity without sending local paths.
//
//   git root → origin remote, normalized to https://host/path → rk_ + 32 hex of its sha256
//   no remote (or no repo) → the lowercased real path of the root or the folder instead
//
// A remote on the deny-list, the home folder and filesystem roots give `none`, which is never
// enabled. Git is run with an argv array, so paths with spaces are passed as they are.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoIdentity {
  readonly repoKey: string;
  /** Last path segment of the normalized string, sent at opt-in (e.g. `memory-anywhere`). */
  readonly displayName: string;
  /** The normalized remote URL, or undefined for a repo without one. Never sent, except as `project.repo` when the owner confirms it. */
  readonly remote: string | undefined;
  /** The local root. Never sent. */
  readonly root: string;
}

export const NONE = "none";

/** The canonical path (symlinks, macOS /private, Windows 8.3 short names resolved), or the path itself. */
function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function git(cwd: string, args: readonly string[]): string | undefined {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** `git@host:path`, `ssh://git@host:22/path.git` and `https://user@HOST/path/` → `https://host/path`. */
export function normalizeRemote(remote: string): string {
  let r = remote.trim();
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/u.exec(r);
  if (scp) r = `https://${scp[1]}/${scp[2]}`;
  const u = new URL(r.replace(/^(?:ssh|git|git\+ssh|http):\/\//u, "https://"));
  const pathPart = u.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
  return `https://${u.hostname.toLowerCase()}${pathPart}`;
}

/** A deny entry is a host, or host/path prefix. */
export function denied(remote: string | undefined, denyRemotes: readonly string[]): boolean {
  if (!remote) return false;
  const target = remote.replace(/^https:\/\//u, "").toLowerCase();
  return denyRemotes.some((d) => {
    const entry = d.replace(/^https?:\/\//u, "").replace(/\/+$/u, "").toLowerCase();
    return target === entry || target.startsWith(`${entry}/`);
  });
}

const keyOf = (normalized: string): string => `rk_${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;

export function repoIdentity(dir: string, denyRemotes: readonly string[] = [], home = os.homedir()): RepoIdentity {
  const cwd = path.resolve(dir);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const remoteRaw = git(cwd, ["remote", "get-url", "origin"]);
  let remote: string | undefined;
  try {
    remote = remoteRaw ? normalizeRemote(remoteRaw) : undefined;
  } catch {
    remote = undefined;
  }
  const real = realPath(root);
  const normalized = remote ?? (process.platform === "win32" ? real.toLowerCase().replaceAll("\\", "/") : real);
  const displayName = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  const resolved = path.resolve(real);
  const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const isRootOrHome = path.dirname(resolved) === resolved || same(resolved, path.resolve(realPath(home)));
  const repoKey = denied(remote, denyRemotes) || isRootOrHome ? NONE : keyOf(normalized);
  return { repoKey, displayName, remote, root: real };
}

/**
 * The proxy's repo folder (spec-issues #28): CLAUDE_PROJECT_DIR, then CURSOR_PROJECT_DIR, then the
 * working directory. Cursor's proxy also follows the active repo its hooks record (#49).
 */
export function proxyRepoDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env["CLAUDE_PROJECT_DIR"] || env["CURSOR_PROJECT_DIR"] || cwd;
}

/** Cursor's `workspace_roots` entries are URL-style (`/C:/Users/…`); this gives a native path. */
export function fromCursorRoot(root: string): string {
  const m = /^\/([A-Za-z]):(\/.*)?$/u.exec(root);
  return m ? `${m[1]}:${(m[2] ?? "/").replaceAll("/", "\\")}` : root;
}
