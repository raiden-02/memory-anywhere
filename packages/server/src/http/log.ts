// Server logs (operations.md §1): one JSON line per request, with ids, codes and timings only.
// Logs never carry memory content, queries, prompts, user_words, tokens or request bodies, so the
// line is built from a closed set of fields and every value is a code, an id or a number.

import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

export interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly req_id?: string;
  readonly route?: string;
  readonly client_id?: string;
  readonly op?: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly status?: number;
  readonly latency_ms?: number;
  readonly ip_prefix?: string;
  readonly error_code?: string;
  /** The MA-Repo-Key a request acted for (a hash, never a path). */
  readonly repo_key?: string;
  /** Which origin served it: `mcp` ({host}) or `admin` (admin.{host}). */
  readonly surface?: "mcp" | "admin";
}

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = (line) => process.stdout.write(`${line}\n`);

const MAX_LOG_BYTES = 1_048_576;
const KEEP_LOGS = 5;

/**
 * Local mode runs hidden, so its stdout goes nowhere: lines are also appended to a file, rotated
 * at 1 MB with five kept (operations.md §1). The lines hold codes and ids only.
 */
export function fileSink(file: string): LogSink {
  return (line) => {
    try {
      if (existsSync(file) && statSync(file).size >= MAX_LOG_BYTES) {
        rmSync(`${file}.${KEEP_LOGS - 1}`, { force: true });
        for (let i = KEEP_LOGS - 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${line}\n`);
    } catch {
      /* logging never stops the server */
    }
  };
}

export const teeSink = (...sinks: LogSink[]): LogSink => (line) => sinks.forEach((s) => s(line));

export class Logger {
  readonly #sink: LogSink;
  readonly #now: () => number;

  constructor(sink: LogSink = stdoutSink, now: () => number = Date.now) {
    this.#sink = sink;
    this.#now = now;
  }

  log(line: LogLine): void {
    this.#sink(JSON.stringify({ ts: new Date(this.#now()).toISOString(), ...line }));
  }
}

/** IPv4 /24 or IPv6 /48 (operations.md §1). */
export function ipPrefix(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+)\.\d+$/u.exec(address);
  if (v4) return `${v4[1]}.0/24`;
  const parts = address.split(":");
  return `${parts.slice(0, 3).join(":")}::/48`;
}
