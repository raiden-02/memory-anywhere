// The job worker (operations.md §4): one loop in the server process. Every second it makes sure
// each recurring job has its next run queued, then runs at most one due job. A failed job is
// retried after 1, 10 and 60 minutes, then dropped (and `memory_status` reports `jobs_failing`).
//
// | Job             | When                              | Does                                      |
// | extract         | a capture batch is flushed        | no-LLM capture (write-path.md §10.3)      |
// | reslot          | after a free-text save            | nothing without an LLM: marked done       |
// | expire          | hourly                            | observations past their TTL               |
// | purge           | hourly                            | forgotten memories past purge_after       |
// | prune           | hourly                            | rows past retention                       |
// | section_cluster | weekly, Sunday 03:00 owner time   | dynamic sections                          |
// | vacuum          | weekly, Sunday 04:00 (local mode) | VACUUM                                    |
// | hmac_rotate     | 90 days after the last rotation   | new audit key                             |

import type { App } from "../app.ts";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { purgeDue } from "../write/forget.ts";
import { runNoLlmExtract } from "../write/prompt.ts";
import { expireObservations, prune, rotateAuditKey, vacuum } from "./maintenance.ts";
import { clusterSections } from "./sections.ts";

export type JobKind = "extract" | "reslot" | "embed" | "reembed" | "section_cluster" | "purge" | "expire" | "digest" | "vacuum" | "manifest" | "prune" | "hmac_rotate";

const BACKOFF_MS = [60_000, 600_000, 3_600_000] as const;

/** When a recurring job runs next after `now`, or undefined if it does not recur in this mode. */
type Schedule = (now: number, app: App) => number | undefined;

const nextHour: Schedule = (now) => Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;

/** The next time it is `weekday` (0 = Sunday) at `hour`:00 in the owner's time zone. */
export function nextWeekly(now: number, timeZone: string, weekday: number, hour: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let t = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS; t <= now + 8 * DAY_MS; t += HOUR_MS) {
    const parts = fmt.formatToParts(t);
    if (days.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "") === weekday && Number(parts.find((p) => p.type === "hour")?.value) === hour) return t;
  }
  throw new Error(`no ${days[weekday] ?? "?"} ${hour}:00 found in ${timeZone}`);
}

const RECURRING: Readonly<Partial<Record<JobKind, Schedule>>> = {
  expire: nextHour,
  purge: nextHour,
  prune: nextHour,
  section_cluster: (now, app) => nextWeekly(now, app.config.owner.timezone, 0, 3),
  vacuum: (now, app) => (app.config.server.mode === "local" ? nextWeekly(now, app.config.owner.timezone, 0, 4) : undefined),
  hmac_rotate: (now, app) => {
    const at = (prepared(app.ctx.db, "SELECT value FROM meta WHERE key = 'audit_hmac_key_rotated_at'").get() as { value: string } | undefined)?.value;
    return Math.max(now, (at ? Date.parse(at) : now) + 90 * DAY_MS);
  },
};

interface JobRow {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload_json: string;
  readonly attempts: number;
}

export class JobWorker {
  readonly #app: App;
  readonly #storeFile: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(app: App, storeFile: string | undefined) {
    this.#app = app;
    this.#storeFile = storeFile;
  }

  start(intervalMs = 1000): void {
    // A job left 'running' by a stopped process runs again.
    prepared(this.#app.ctx.db, "UPDATE job SET status = 'queued' WHERE status = 'running'").run();
    this.#timer ??= setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One turn: schedule recurring jobs, then run at most one due job. Returns the kind it ran. */
  async tick(): Promise<JobKind | undefined> {
    if (this.#running) return undefined;
    this.#running = true;
    try {
      this.schedule();
      return await this.#runOne();
    } finally {
      this.#running = false;
    }
  }

  schedule(): void {
    const { db, clock, ids } = this.#app.ctx;
    const now = clock.now();
    for (const [kind, next] of Object.entries(RECURRING) as [JobKind, Schedule][]) {
      const pending = prepared(db, "SELECT 1 FROM job WHERE kind = ? AND status IN ('queued','running') LIMIT 1").get(kind);
      const at = next(now, this.#app);
      if (pending || at === undefined) continue;
      prepared(db, "INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, ?, '{}', 0, ?, 'queued', ?)")
        .run(ids.newId("job", now), kind, iso(at), iso(now));
    }
  }

  async #runOne(): Promise<JobKind | undefined> {
    const { db, clock } = this.#app.ctx;
    const job = prepared(db, "SELECT id, kind, payload_json, attempts FROM job WHERE status = 'queued' AND next_at <= ? ORDER BY next_at, id LIMIT 1")
      .get(iso(clock.now())) as JobRow | undefined;
    if (!job) return undefined;
    prepared(db, "UPDATE job SET status = 'running' WHERE id = ?").run(job.id);
    try {
      await this.#run(job);
      prepared(db, "UPDATE job SET status = 'done', last_error = NULL WHERE id = ?").run(job.id);
    } catch (e) {
      const attempts = job.attempts + 1;
      const delay = BACKOFF_MS[attempts - 1];
      // Only the error's class and code are kept: messages may quote stored text.
      const code = `${e instanceof Error ? e.name : "Error"}${(e as { code?: string }).code ? `:${(e as { code?: string }).code}` : ""}`;
      prepared(db, "UPDATE job SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?")
        .run(delay === undefined ? "dropped" : "queued", attempts, iso(clock.now() + (delay ?? 0)), code, job.id);
    }
    return job.kind;
  }

  async #run(job: JobRow): Promise<void> {
    const app = this.#app;
    switch (job.kind) {
      case "extract":
        await runNoLlmExtract(app.write, job.payload_json);
        return;
      case "expire":
        expireObservations(app.ctx);
        return;
      case "purge":
        app.committed(purgeDue(app.ctx, app.config.server.mode));
        return;
      case "prune":
        prune(app.ctx, app.config, this.#storeFile);
        return;
      case "section_cluster":
        if (clusterSections(app.ctx, app.config, app.embedder.modelId).created.length > 0) app.committed([]);
        return;
      case "vacuum":
        vacuum(app.ctx);
        return;
      case "hmac_rotate":
        rotateAuditKey(app.ctx);
        return;
      case "reslot":
        return; // slot proposals need an LLM (write-path.md §6.2); with provider none there is nothing to do
      default:
        throw new Error(`job kind ${job.kind} is not run by this server`);
    }
  }
}
