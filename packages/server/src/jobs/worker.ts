// The job worker (operations.md §4): one loop in the server process. Every second it makes sure
// each recurring job has its next run queued, then starts due jobs in queue order. A failed job is
// retried after 1, 10 and 60 minutes, then dropped (and `memory_status` reports `jobs_failing`).
//
// Extract jobs mostly wait on the model, so up to `llm.parallel_extract` of them run at once; any
// other job runs alone:
//
//   queue (next_at, id) ──► extract ─── fewer than parallel_extract running? ──► start it, look again
//                       └─► any other ─ nothing running? ──────────────────────► start it, stop
//                           (otherwise the worker waits for the running jobs to finish first)
//
// | Job             | When                              | Does                                      |
// | extract         | a capture batch is flushed        | the extractor, or no-LLM capture (§10.3)  |
// |                 | an import's extract item arrives  | the extractor, then the span check and    |
// |                 |                                   | the write path (write-path.md §10.2, §10.4)|
// | reslot          | a slot proposal that timed out    | asks again; fills or contests, never      |
// |                 | (write-path.md §6.2)              | supersedes (retries 1 h, 6 h, 17 h)       |
// | expire          | hourly                            | observations past their TTL               |
// | purge           | hourly                            | forgotten memories past purge_after       |
// | prune           | hourly                            | rows past retention                       |
// | section_cluster | weekly, Sunday 03:00 owner time   | dynamic sections                          |
// | vacuum          | weekly, Sunday 04:00 (local mode) | VACUUM                                    |
// | hmac_rotate     | 90 days after the last rotation   | new audit key                             |
// | digest          | daily at digest_hour_local (aws)  | the alert digest email (operations.md §2) |
// | manifest        | daily, 05:00 owner time (aws)     | checks the newest stored manifest, stores |
// |                 |                                   | today's (ops/manifest.ts)                 |
//
// Around the jobs (operations.md §2, deployment-aws.md §4): a dropped job raises `job_failed`;
// each hourly prune also checks free disk (`disk_low` under 20%); in aws mode a purge leaves the
// flag `maint/purge-pending`, so that night's `ma-maint` compacts the store.

import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { purgeDue } from "../write/forget.ts";
import { runImportExtract } from "../write/imports.ts";
import { runCaptureExtract } from "../write/prompt.ts";
import { RESLOT_BACKOFF_MS, runReslot } from "../llm/slots.ts";
import { runManifestJob } from "../ops/manifest.ts";
import { expireObservations, prune, rotateAuditKey, vacuum } from "./maintenance.ts";
import { clusterSections } from "./sections.ts";
import { metaValue } from "../store/meta.ts";

export type JobKind =
	| "extract"
	| "reslot"
	| "embed"
	| "reembed"
	| "section_cluster"
	| "purge"
	| "expire"
	| "digest"
	| "vacuum"
	| "manifest"
	| "prune"
	| "hmac_rotate";

const BACKOFF_MS = [60_000, 600_000, 3_600_000] as const;

/** When a recurring job runs next after `now`, or undefined if it does not recur in this mode. */
type Schedule = (now: number, app: App) => number | undefined;

const nextHour: Schedule = (now) => Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The next whole hour after `now` that is `hour`:00 in the owner's time zone, on `weekday` (0 = Sunday) if given. */
function nextLocal(now: number, timeZone: string, hour: number, weekday: number | undefined): number {
	const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
	for (let t = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS; t <= now + 8 * DAY_MS; t += HOUR_MS) {
		const parts = fmt.formatToParts(t);
		const dayOk =
			weekday === undefined ||
			DAYS.indexOf((parts.find((p) => p.type === "weekday")?.value ?? "") as (typeof DAYS)[number]) === weekday;
		if (dayOk && Number(parts.find((p) => p.type === "hour")?.value) === hour) return t;
	}
	throw new Error(`no ${weekday === undefined ? "" : `${DAYS[weekday] ?? "?"} `}${hour}:00 found in ${timeZone}`);
}

/** The next time it is `weekday` (0 = Sunday) at `hour`:00 in the owner's time zone. */
export const nextWeekly = (now: number, timeZone: string, weekday: number, hour: number): number =>
	nextLocal(now, timeZone, hour, weekday);

/** The next time it is `hour`:00 in the owner's time zone. */
export const nextDaily = (now: number, timeZone: string, hour: number): number =>
	nextLocal(now, timeZone, hour, undefined);

const RECURRING: Readonly<Partial<Record<JobKind, Schedule>>> = {
	expire: nextHour,
	purge: nextHour,
	prune: nextHour,
	section_cluster: (now, app) => nextWeekly(now, app.config.owner.timezone, 0, 3),
	vacuum: (now, app) =>
		app.config.server.mode === "local" ? nextWeekly(now, app.config.owner.timezone, 0, 4) : undefined,
	digest: (now, app) =>
		app.config.server.mode === "aws"
			? nextDaily(now, app.config.owner.timezone, app.config.alerts.digest_hour_local)
			: undefined,
	// After the nightly ma-maint (04:15), so a compaction never runs during the hash.
	manifest: (now, app) => (app.config.server.mode === "aws" ? nextDaily(now, app.config.owner.timezone, 5) : undefined),
	hmac_rotate: (now, app) => {
		const at = metaValue(app.ctx.db, "audit_hmac_key_rotated_at");
		return Math.max(now, (at ? Date.parse(at) : now) + 90 * DAY_MS);
	},
};

interface JobRow {
	readonly id: string;
	readonly kind: JobKind;
	readonly payload_json: string;
	readonly attempts: number;
}

export interface JobWorkerOptions {
	/** The store file (aws and local mode); undefined for an in-memory store. */
	readonly storeFile?: string;
	/** Work that runs with each hourly prune (the owner-reset schedule). */
	readonly hourly?: readonly (() => void)[];
	/** aws mode: where the outbox script drops fetched files (the manifest job reads them there). */
	readonly dropDir?: string;
}

export class JobWorker {
	readonly #app: App;
	readonly #storeFile: string | undefined;
	readonly #hourly: readonly (() => void)[];
	readonly #dropDir: string | undefined;
	#timer: NodeJS.Timeout | undefined;
	/** The jobs running now, by kind: extract jobs, or a single job of another kind. */
	readonly #running = new Map<string, JobKind>();

	constructor(app: App, o: JobWorkerOptions = {}) {
		this.#app = app;
		this.#storeFile = o.storeFile;
		this.#hourly = o.hourly ?? [];
		this.#dropDir = o.dropDir;
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

	/**
	 * One turn: schedule recurring jobs, start every due job that may run now (see the top of this
	 * file), and wait for the ones this turn started. Returns the kind of the first, if any. Turns
	 * overlap: the next second's turn fills the extract slots the jobs still running leave free.
	 */
	async tick(): Promise<JobKind | undefined> {
		this.schedule();
		const started: Promise<void>[] = [];
		let first: JobKind | undefined;
		for (let job = this.#next(); job; job = this.#next()) {
			first ??= job.kind;
			started.push(this.#runJob(job));
			if (job.kind !== "extract") break;
		}
		await Promise.all(started);
		return first;
	}

	schedule(): void {
		const { db, clock, ids } = this.#app.ctx;
		const now = clock.now();
		for (const [kind, next] of Object.entries(RECURRING) as [JobKind, Schedule][]) {
			const pending = prepared(db, "SELECT 1 FROM job WHERE kind = ? AND status IN ('queued','running') LIMIT 1").get(
				kind,
			);
			const at = next(now, this.#app);
			if (pending || at === undefined) continue;
			prepared(
				db,
				"INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES (?, ?, '{}', 0, ?, 'queued', ?)",
			).run(ids.newId("job", now), kind, iso(at), iso(now));
		}
	}

	/** Claims the first due job if it may start now (marks it running), else undefined. */
	#next(): JobRow | undefined {
		const { db, clock } = this.#app.ctx;
		const job = prepared(
			db,
			"SELECT id, kind, payload_json, attempts FROM job WHERE status = 'queued' AND next_at <= ? ORDER BY next_at, id LIMIT 1",
		).get(iso(clock.now())) as JobRow | undefined;
		if (!job) return undefined;
		const running = [...this.#running.values()];
		const free =
			job.kind === "extract"
				? running.every((k) => k === "extract") && running.length < this.#app.config.llm.parallel_extract
				: running.length === 0;
		if (!free) return undefined;
		prepared(db, "UPDATE job SET status = 'running' WHERE id = ?").run(job.id);
		this.#running.set(job.id, job.kind);
		return job;
	}

	async #runJob(job: JobRow): Promise<void> {
		const { db, clock } = this.#app.ctx;
		try {
			await this.#run(job);
			prepared(db, "UPDATE job SET status = 'done', last_error = NULL WHERE id = ?").run(job.id);
		} catch (e) {
			const attempts = job.attempts + 1;
			const delay = (job.kind === "reslot" ? RESLOT_BACKOFF_MS : BACKOFF_MS)[attempts - 1];
			// Only the error's class and code are kept: messages may quote stored text.
			const code = `${e instanceof Error ? e.name : "Error"}${(e as { code?: string }).code ? `:${(e as { code?: string }).code}` : ""}`;
			prepared(db, "UPDATE job SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?").run(
				delay === undefined ? "dropped" : "queued",
				attempts,
				iso(clock.now() + (delay ?? 0)),
				code,
				job.id,
			);
			if (delay === undefined) this.#app.alerts.raise("job_failed", { job: job.id }, { subject: job.kind });
		} finally {
			this.#running.delete(job.id);
		}
	}

	async #run(job: JobRow): Promise<void> {
		const app = this.#app;
		switch (job.kind) {
			case "extract": {
				const importItem = (JSON.parse(job.payload_json) as { import_item_key?: string }).import_item_key;
				if (importItem) await runImportExtract(app.write, app.llm, importItem, job.attempts);
				else await runCaptureExtract(app.write, app.llm, job.payload_json);
				return;
			}
			case "expire":
				expireObservations(app.ctx);
				return;
			case "purge": {
				const purged = purgeDue(app.ctx, app.config.server.mode);
				app.committed(purged);
				if (purged.length > 0 && app.config.server.mode === "aws" && this.#storeFile) {
					const maint = path.join(path.dirname(this.#storeFile), "maint");
					mkdirSync(maint, { recursive: true });
					writeFileSync(
						path.join(maint, "purge-pending"),
						`${iso(app.ctx.clock.now())}
`,
					);
				}
				return;
			}
			case "prune":
				prune(app.ctx, app.config, this.#storeFile);
				if (this.#storeFile) checkDisk(app, path.dirname(this.#storeFile));
				for (const run of this.#hourly) run();
				return;
			case "digest":
				app.alerts.sendDigest();
				return;
			case "section_cluster":
				if (clusterSections(app.ctx, app.config, app.embedder.modelId).created.length > 0) app.committed([]);
				return;
			case "vacuum":
				vacuum(app.ctx);
				return;
			case "manifest":
				if (!this.#dropDir) throw new Error("the manifest job runs only in aws mode");
				await runManifestJob(app, { dropDir: this.#dropDir });
				return;
			case "hmac_rotate":
				rotateAuditKey(app.ctx);
				return;
			case "reslot":
				app.committed(await runReslot(app.ctx, app.llm, job.payload_json));
				return;
			default:
				throw new Error(`job kind ${job.kind} is not run by this server`);
		}
	}
}

/** Raises `disk_low` when the data directory's volume has less than 20% free (operations.md §2). */
export function checkDisk(app: App, dir: string): void {
	const s = statfsSync(dir);
	if (s.blocks <= 0) return;
	const freePct = Math.round((Number(s.bavail) / Number(s.blocks)) * 100);
	if (freePct < 20) app.alerts.raise("disk_low", { free_pct: freePct });
}
