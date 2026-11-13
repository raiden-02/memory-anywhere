// `memory-anywhere-server selfcheck` (spec-issues #57, #76): the on-instance checks of suite S that
// need root on an eval stack, run without giving the deploy role any new right.
//
//   harness (owner session) ── POST /api/selfcheck {canaries} ──► /run/memory-anywhere/selfcheck/request.json (tmpfs)
//   ma-selfcheck.path (eval stacks only) ──► ma-selfcheck.service (root) ──► selfcheck ──► maint/selfcheck.json
//   harness (owner session) ── GET /api/selfcheck ──► the result: check ids, pass/fail, counts; never a canary
//
// The canaries are purged eval strings. They stay on tmpfs and in memory (MemorySwapMax=0), so a
// scan of the raw device or the swap file can only find them where a purge failed to clear them.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerConfigT } from "../config/schema.ts";

export interface SelfcheckRequest {
  /** Purged strings that must appear nowhere (S-PURGE). */
  readonly canaries: readonly string[];
}

export interface Check {
  readonly id: string;
  readonly pass: boolean;
  /** Counts and paths only: never a canary. */
  readonly detail: string;
}

export interface SelfcheckResult {
  readonly at: string;
  readonly checks: readonly Check[];
}

export interface SelfcheckEnv {
  /** The store's folder. */
  readonly dataDir: string;
  /** Raw block devices to scan (eval stacks: /dev/nvme0n1). */
  readonly devices: readonly string[];
  /** Swap files to scan. */
  readonly swapFiles: readonly string[];
  /** Users that must not reach IMDS (auth-and-security.md §9). */
  readonly imdsDeniedUsers: readonly string[];
  /** Runs a command as a user; returns its exit status. Injected so tests run anywhere. */
  readonly runAs: (user: string, command: string, args: readonly string[]) => number | null;
  readonly now: () => number;
}

const CHUNK = 4 * 2 ** 20;

/**
 * Whether any needle occurs in `file`, read in chunks with an overlap as long as the longest
 * needle, so a match across two chunks is not missed. Unreadable → undefined.
 */
export function fileHolds(file: string, needles: readonly Buffer[]): boolean | undefined {
  const longest = Math.max(...needles.map((n) => n.length));
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(CHUNK + longest);
    let carried = 0;
    let position = 0;
    for (;;) {
      const read = readSync(fd, buf, carried, CHUNK, position);
      if (read === 0) return false;
      position += read;
      const window = buf.subarray(0, carried + read);
      if (needles.some((n) => window.includes(n))) return true;
      carried = Math.min(longest - 1, window.length);
      window.copy(buf, 0, window.length - carried);
    }
  } finally {
    closeSync(fd);
  }
}

/** The needles for a canary: its bytes as written, in lower case, and as UTF-16 (a Windows-style copy). */
function needlesOf(canaries: readonly string[]): Buffer[] {
  return canaries.flatMap((c) => [Buffer.from(c, "utf8"), Buffer.from(c.toLowerCase(), "utf8"), Buffer.from(c, "utf16le")]);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    const s = statSync(p, { throwIfNoEntry: false });
    return s?.isDirectory() ? filesUnder(p) : s?.isFile() ? [p] : [];
  });
}

export function runSelfcheck(req: SelfcheckRequest, env: SelfcheckEnv): SelfcheckResult {
  const checks: Check[] = [];
  for (const user of env.imdsDeniedUsers) {
    // IMDSv2's token call: refused by the nftables rule for these users (deployment-aws.md §4 step 3).
    const status = env.runAs(user, "curl", ["-sS", "-m", "3", "-X", "PUT", "-H", "X-aws-ec2-metadata-token-ttl-seconds: 60", "http://169.254.169.254/latest/api/token"]);
    checks.push({ id: `imds.denied.${user}`, pass: status !== 0, detail: `curl exit ${String(status)}` });
  }
  const files = filesUnder(env.dataDir);
  const staging = files.filter((f) => /litestream|\.ltx$/iu.test(path.relative(env.dataDir, f)));
  checks.push({ id: "litestream.no-staging-on-volume", pass: staging.length === 0, detail: `${staging.length} Litestream file(s) under the data directory` });
  if (req.canaries.length > 0) {
    const needles = needlesOf(req.canaries);
    const holding = files.filter((f) => fileHolds(f, needles) === true);
    checks.push({ id: "purge.data-dir", pass: holding.length === 0, detail: holding.length === 0 ? `${files.length} files clean` : `found in ${holding.map((f) => path.relative(env.dataDir, f)).join(", ")}` });
    for (const [id, targets] of [["purge.raw-device", env.devices], ["purge.swap", env.swapFiles]] as const) {
      for (const t of targets) {
        const found = fileHolds(t, needles);
        checks.push({ id: `${id}:${t}`, pass: found === false, detail: found === undefined ? "could not read it" : found ? "a canary is present" : "clean" });
      }
    }
  }
  return { at: new Date(env.now()).toISOString(), checks };
}

/**
 * Where a request and its result live, or undefined when selfcheck is off. The request (with the
 * canaries) is on tmpfs beside the socket; the result (ids and counts only) in the data folder.
 */
export function selfcheckFiles(config: ServerConfigT, dataDir: string): { request: string; result: string } | undefined {
  if (!config.deployment.selfcheck) return undefined;
  const run = config.server.listen.startsWith("unix:") ? path.dirname(config.server.listen.slice("unix:".length)) : path.join(dataDir, "run");
  return { request: path.join(run, "selfcheck", "request.json"), result: path.join(dataDir, "maint", "selfcheck.json") };
}

/** A request from the admin route: 1–50 canaries of 4–100 characters. */
export function parseRequest(body: unknown): SelfcheckRequest | undefined {
  const canaries = (body as { canaries?: unknown } | undefined)?.canaries;
  if (!Array.isArray(canaries) || canaries.length < 1 || canaries.length > 50) return undefined;
  if (!canaries.every((c): c is string => typeof c === "string" && c.length >= 4 && c.length <= 100)) return undefined;
  return { canaries };
}

/** The instance's defaults: the root volume, the swap file, the server and Caddy users. */
export function instanceEnv(dataDir: string): SelfcheckEnv {
  return {
    dataDir,
    devices: ["/dev/nvme0n1"].filter((d) => existsSync(d)),
    swapFiles: ["/swapfile"].filter((f) => existsSync(f)),
    imdsDeniedUsers: ["memory-anywhere", "caddy"],
    runAs: (user, command, args) => spawnSync("runuser", ["-u", user, "--", command, ...args], { stdio: "ignore", timeout: 10_000 }).status,
    now: Date.now,
  };
}
