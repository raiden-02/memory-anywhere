// Server logs (operations.md §1): one JSON line per request, with ids, codes and timings only.
// Logs never carry memory content, queries, prompts, user_words, tokens or request bodies, so the
// line is built from a closed set of fields and every value is a code, an id or a number.

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
}

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = (line) => process.stdout.write(`${line}\n`);

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
