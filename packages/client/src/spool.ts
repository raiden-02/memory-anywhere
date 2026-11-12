// The spool (topology-and-ipc.md §9): writes that could not reach the store wait here, one file
// per entry, and are replayed in ULID order. Files hold only redacted text, the folder is
// user-only, and the server treats replays as untrusted input.
//
//   {data}\spool\
//     01JC9Z….json        one record each, written as .tmp then renamed
//     .drain.lock         one drainer at a time (stale after 60 s)
//     dead\               records that failed to parse 3 times
//     rejected.log        policy rejections: key, op, outcome, reason, time (no content)

import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpoolRecord, spoolRecordToEntry, SPOOL_FORMAT_VERSION, type SpoolRecordT } from "@memory-anywhere/contracts/spool";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir, writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import type { WriteResultT } from "@memory-anywhere/contracts/schemas/v1";
import { StoreError, type StoreClient } from "./store-client.ts";

const LOCK_STALE_MS = 60_000;
const BATCH = 100;
const MAX_PARSE_FAILURES = 3;
const REJECTED_KEEP_MS = 30 * 86_400_000;

export interface SpoolLimits {
  readonly maxBytes: number;
  readonly maxAgeDays: number;
}

type SpoolPaths = Pick<Paths, "spoolDir" | "spoolDeadDir" | "spoolDrainLock" | "spoolRejectedLog">;

/** The ULID part of the key names the file, so a record is spooled at most once. */
const fileOf = (p: SpoolPaths, key: string): string => path.join(p.spoolDir, `${key.slice(4)}.json`);

export function spoolWrite(p: SpoolPaths, record: Omit<SpoolRecordT, "format_version">): void {
  ensurePrivateDir(p.spoolDir);
  const full = SpoolRecord.parse({ format_version: SPOOL_FORMAT_VERSION, ...record });
  writeFileAtomic(fileOf(p, full.idempotency_key), JSON.stringify(full), { private: false });
}

export interface SpoolStats {
  readonly count: number;
  readonly bytes: number;
  readonly oldestMs: number | undefined;
}

function entries(p: SpoolPaths): string[] {
  if (!existsSync(p.spoolDir)) return [];
  return readdirSync(p.spoolDir).filter((f) => /^[0-9A-Z]{26}\.json$/u.test(f)).sort();
}

export function spoolStats(p: SpoolPaths): SpoolStats {
  let bytes = 0;
  let oldest: number | undefined;
  const files = entries(p);
  for (const f of files) {
    const st = statSync(path.join(p.spoolDir, f));
    bytes += st.size;
    oldest = Math.min(oldest ?? st.mtimeMs, st.mtimeMs);
  }
  return { count: files.length, bytes, oldestMs: oldest };
}

/** Past either limit, the oldest entries are deleted (and logged). Returns how many. */
export function enforceLimits(p: SpoolPaths, limits: SpoolLimits, now: number, log: (line: string) => void): number {
  const files = entries(p).map((f) => ({ f, st: statSync(path.join(p.spoolDir, f)) }));
  let total = files.reduce((s, x) => s + x.st.size, 0);
  let removed = 0;
  for (const { f, st } of files) {
    const tooOld = now - st.mtimeMs > limits.maxAgeDays * 86_400_000;
    if (!tooOld && total <= limits.maxBytes) break;
    rmSync(path.join(p.spoolDir, f), { force: true });
    total -= st.size;
    removed++;
    log(`spool: dropped ${f} (${tooOld ? "older than the limit" : "spool over its size limit"})`);
  }
  return removed;
}

function takeLock(p: SpoolPaths, now: number): boolean {
  try {
    closeSync(openSync(p.spoolDrainLock, "wx"));
    return true;
  } catch {
    try {
      if (now - statSync(p.spoolDrainLock).mtimeMs > LOCK_STALE_MS) {
        rmSync(p.spoolDrainLock, { force: true });
        closeSync(openSync(p.spoolDrainLock, "wx"));
        return true;
      }
    } catch {
      /* another process took it */
    }
    return false;
  }
}

export interface DrainResult {
  readonly sent: number;
  readonly remaining: number;
  /** The lock was held by another process. */
  readonly busy: boolean;
}

/**
 * Replays spooled entries until the deadline: batches of ≤ 100 in ULID order. An entry is deleted
 * once the store gave a definitive answer for it; an offline store leaves everything in place.
 */
export async function drain(p: SpoolPaths, store: StoreClient, deadline: number, now: () => number = Date.now): Promise<DrainResult> {
  if (entries(p).length === 0) return { sent: 0, remaining: 0, busy: false };
  if (!takeLock(p, now())) return { sent: 0, remaining: entries(p).length, busy: true };
  let sent = 0;
  try {
    pruneRejectedLog(p, now());
    for (;;) {
      const files = entries(p).slice(0, BATCH);
      if (files.length === 0 || now() >= deadline) break;
      const batch: { file: string; record: SpoolRecordT }[] = [];
      for (const f of files) {
        const record = parseOrQuarantine(p, f);
        if (record) batch.push({ file: f, record });
      }
      if (batch.length === 0) continue;
      let results: WriteResultT[];
      try {
        const res = await store.request<{ results: WriteResultT[] }>("POST", "/v1/writes", { entries: batch.map((b) => spoolRecordToEntry(b.record)) }, Math.max(100, deadline - now()));
        results = res?.results ?? [];
      } catch (e) {
        // 4xx other than 401/408/429 is definitive for the whole batch; anything else waits.
        if (e instanceof StoreError && e.kind === "rejected") {
          for (const b of batch) {
            rmSync(path.join(p.spoolDir, b.file), { force: true });
            logRejected(p, b.record, "rejected", `http_${e.status ?? 400}`, now());
          }
          continue;
        }
        break;
      }
      const before = sent;
      for (const b of batch) {
        const r = results.find((x) => x.idempotency_key === b.record.idempotency_key);
        if (!r) continue;
        rmSync(path.join(p.spoolDir, b.file), { force: true });
        if (r.outcome === "rejected") logRejected(p, b.record, r.outcome, r.reason, now());
        sent++;
      }
      if (sent === before) break; // the store answered without a result for these entries: try again later
    }
  } finally {
    rmSync(p.spoolDrainLock, { force: true });
  }
  return { sent, remaining: entries(p).length, busy: false };
}

/** A record that fails to parse is retried; on the third failure it moves to dead\. */
function parseOrQuarantine(p: SpoolPaths, file: string): SpoolRecordT | undefined {
  const full = path.join(p.spoolDir, file);
  try {
    return SpoolRecord.parse(JSON.parse(readFileSync(full, "utf8")));
  } catch {
    const counter = `${full}.failures`;
    const failures = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    if (failures >= MAX_PARSE_FAILURES) {
      ensurePrivateDir(p.spoolDeadDir);
      renameSync(full, path.join(p.spoolDeadDir, file));
      rmSync(counter, { force: true });
    } else {
      writeFileSync(counter, String(failures));
    }
    return undefined;
  }
}

function logRejected(p: SpoolPaths, r: SpoolRecordT, outcome: string, reason: string, now: number): void {
  appendFileSync(p.spoolRejectedLog, `${JSON.stringify({ idempotency_key: r.idempotency_key, op: r.op, outcome, reason, at: new Date(now).toISOString() })}\n`);
}

function pruneRejectedLog(p: SpoolPaths, now: number): void {
  if (!existsSync(p.spoolRejectedLog)) return;
  const keep = readFileSync(p.spoolRejectedLog, "utf8").split("\n").filter((l) => {
    if (!l) return false;
    const at = Date.parse((JSON.parse(l) as { at?: string }).at ?? "");
    return Number.isFinite(at) && now - at < REJECTED_KEEP_MS;
  });
  writeFileSync(p.spoolRejectedLog, keep.map((l) => `${l}\n`).join(""));
}
