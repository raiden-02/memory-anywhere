// The pieces aws mode adds around the core — alerts and the outbox, restored state, store
// compaction, and the front door that tells the mcp and admin surfaces apart behind Caddy.

import type { App } from "../src/app.ts";
import { randomBytes } from "node:crypto";
import { newId } from "@memory-anywhere/contracts/ids";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { request, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_AUTH } from "../src/api/grant.ts";
import { StepUps } from "../src/auth/stepup.ts";
import { ServerConfig } from "../src/config/schema.ts";
import { awsDoor } from "../src/http/front.ts";
import { Logger } from "../src/http/log.ts";
import { createHttpServer } from "../src/http/server.ts";
import { Alerts } from "../src/ops/alerts.ts";
import { compactStore } from "../src/ops/compact.ts";
import { zeroAndDelete } from "../src/store/wal-hold.ts";
import { FileOutbox, NO_OUTBOX } from "../src/ops/outbox.ts";
import { buildManifest, chainReaches, restartManifests, runManifestJob, type ManifestT } from "../src/ops/manifest.ts";
import { storeHash } from "../src/store/dump.ts";
import { enterRestoredState, RestoreCheckFailed, restoredManifestFile } from "../src/ops/restored.ts";
import { HOUR_MS, iso } from "../src/store/clock.ts";
import { openStore } from "../src/store/db.ts";
import { LOCAL_CLIENT_ID } from "../src/store/init.ts";
import { save } from "../src/write/pipeline.ts";
import { CHAT_CLIENT_ID, chatCaller, saveReq, T0_MS, testStore, type TestStore, testApp } from "./helpers/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "ma ops "));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}

/** A store whose clock the test moves by hand. */
async function storeAt(): Promise<{ s: TestStore; clock: { t: number } }> {
	const s = await testStore({ memory: true });
	cleanup.push(() => s.close());
	const clock = { t: T0_MS };
	return { s: { ...s, clock: { now: () => clock.t } }, clock };
}

describe("alerts", () => {
	it("emails an immediate alert once, counts repeats, and emails again only after an hour", async () => {
		const { s, clock } = await storeAt();
		const outbox = tempDir();
		const alerts = new Alerts(s, new FileOutbox(outbox));
		const id = alerts.raise("auth_fail", { attempts: 5 });
		expect(JSON.parse(readFileSync(path.join(outbox, "alert-auth_fail.json"), "utf8"))).toMatchObject({
			id: "auth_fail",
			count: 1,
		});
		rmSync(path.join(outbox, "alert-auth_fail.json"));

		clock.t += 10 * 60_000;
		expect(alerts.raise("auth_fail", { attempts: 6 })).toBe(id);
		expect(readdirSync(outbox)).toEqual([]); // within the hour: counted, not emailed
		clock.t += HOUR_MS;
		alerts.raise("auth_fail", { attempts: 7 });
		expect(JSON.parse(readFileSync(path.join(outbox, "alert-auth_fail.json"), "utf8"))).toMatchObject({
			count: 3,
			details: { attempts: 7 },
		});
		expect(alerts.open()).toHaveLength(1);
	});

	it("keeps one open alert per subject, and a new one after acknowledgement", async () => {
		const { s } = await storeAt();
		const alerts = new Alerts(s, NO_OUTBOX);
		const a = alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
		alerts.raise("save_quota", { quota: 20 }, { subject: "cli_b" });
		expect(alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" })).toBe(a);
		alerts.acknowledge(a);
		expect(alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" })).not.toBe(a);
		expect(alerts.open().map((r) => [r.subject, r.count])).toEqual(
			expect.arrayContaining([
				["cli_a", 1],
				["cli_b", 1],
			]),
		);
	});

	it("a save over the hourly quota is refused and puts the client in the digest", async () => {
		const s = await testStore({ memory: true });
		cleanup.push(() => s.close());
		const app = testApp(s);
		s.db.prepare("UPDATE client_policy SET quota_saves_per_hour = 1 WHERE client_id = ?").run(CHAT_CLIENT_ID);
		const put = (text: string) =>
			save(app.write, chatCaller(), saveReq(text), { idempotencyKey: newId("pxs"), observedAt: s.clock.now() });
		await put("Prefers tea over coffee");
		await expect(put("Lives in Lisbon")).rejects.toMatchObject({ code: "RATE_LIMITED" });
		expect(app.alerts.open().map((a) => [a.kind, a.subject])).toEqual([["save_quota", CHAT_CLIENT_ID]]);
	});

	it("refuses details that could carry text, so no memory content reaches an email", async () => {
		const { s } = await storeAt();
		const alerts = new Alerts(s, NO_OUTBOX);
		expect(() => alerts.raise("job_failed", { note: "the user lives in Lisbon" })).toThrow(/not an id or code/u);
	});

	it("lists digest alerts once a day, only those raised or repeated since the last digest", async () => {
		const { s, clock } = await storeAt();
		const outbox = tempDir();
		const alerts = new Alerts(s, new FileOutbox(outbox));
		alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
		alerts.raise("pairing_race", {}); // immediate only: not in the digest
		expect(alerts.sendDigest()).toBe(1);
		const body = JSON.parse(readFileSync(path.join(outbox, `digest-${iso(clock.t).slice(0, 10)}.json`), "utf8")) as {
			alerts: { kind: string }[];
		};
		expect(body.alerts.map((a) => a.kind)).toEqual(["save_quota"]);
		clock.t += 60_000;
		expect(alerts.sendDigest()).toBe(0);
		clock.t += 60_000;
		alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
		expect(alerts.sendDigest()).toBe(1);
	});
});

describe("outbox", () => {
	it("writes a file atomically under a name the outbox script knows, and refuses any other", () => {
		const dir = tempDir();
		const outbox = new FileOutbox(dir);
		outbox.send("setup-token", "secret");
		expect(readdirSync(dir)).toEqual(["setup-token"]);
		expect(() => outbox.send("../escape", "x")).toThrow(/not an outbox file name/u);
		expect(() => outbox.send("alert-Bad Name.json", "x")).toThrow(/not an outbox file name/u);
	});

	it("S-AWS-13: a name that would leave the outbox, smuggle a second line, or forge a manifest key is refused, and nothing is written", () => {
		// A parent of its own, so a stray file in the system temp folder cannot fail the check below.
		const dir = path.join(tempDir(), "outbox");
		mkdirSync(dir);
		const outbox = new FileOutbox(dir);
		const names = [
			"manifest-../x",
			"manifest-../../inbox/drop/manifest-01JC9Z3N4V8Q2W5X7Y9Z0A1B2C.json",
			"manifest-fetch-../../x",
			"manifest-fetch-01jc9z3n4v8q2w5x7y9z0a1b2c",
			"manifest-2026-11-16.json\nsetup-token",
			"manifest-2026-11-16.json/../setup-token",
			"manifest-2026-11-16.json.sh",
			"alert-../../x.json",
			"alert-x.json\n",
			"digest-2026-11-16.json ",
			"fetch-01JC9Z3N4V8Q2W5X7Y9Z0A1B2C/../../x",
			"setup-token.delete\n",
			".manifest-2026-11-16.json.tmp",
		];
		for (const name of names)
			expect(() => outbox.send(name, "{}"), JSON.stringify(name)).toThrow(/not an outbox file name/u);
		expect(readdirSync(dir)).toEqual([]);
		expect(readdirSync(path.dirname(dir)).filter((f) => f === "x" || f === "setup-token")).toEqual([]);
	});
});

describe("restored state", () => {
	async function seeded(): Promise<{ s: TestStore; alerts: Alerts; flag: string; now: number }> {
		const { s, clock } = await storeAt();
		const at = iso(clock.t);
		s.db
			.prepare(
				"INSERT INTO admin_session (id_hash, created_at, last_seen_at, uv_at, expires_at) VALUES ('h', ?, ?, ?, ?)",
			)
			.run(at, at, at, iso(clock.t + HOUR_MS));
		s.db
			.prepare(
				"INSERT INTO pairing_window (id, vendor, method, opened_at, expires_at, pair_code) VALUES ('w', 'claude', 'static', ?, ?, 'ABCD2345')",
			)
			.run(at, iso(clock.t + 600_000));
		s.db.prepare("INSERT INTO grant_meta (grant_id, client_id, created_at) VALUES ('g1', 'cli_chat', ?)").run(at);
		s.db
			.prepare("INSERT INTO oidc_store (model, id, payload_json, grant_id) VALUES ('RefreshToken', 'r1', '{}', 'g1')")
			.run();
		const flag = path.join(tempDir(), "restored");
		return { s, alerts: new Alerts(s, NO_OUTBOX), flag, now: clock.t };
	}

	/** What the restore scripts leave: the flag, and the newest stored manifest (null: none yet). */
	function restoredWith(flag: string, body: string, manifest: ManifestT | null = null): void {
		writeFileSync(restoredManifestFile(flag), JSON.stringify(manifest));
		writeFileSync(flag, body);
	}

	it("does nothing without the flag", async () => {
		const { s, alerts, flag } = await seeded();
		expect(enterRestoredState(s, alerts, flag)).toBeUndefined();
	});

	it("after a lost instance: new secrets, sessions and windows revoked, grants kept, alert raised, flag removed", async () => {
		const { s, alerts, flag } = await seeded();
		restoredWith(flag, '{"reason":"lost","to":""}\n');
		expect(enterRestoredState(s, alerts, flag)).toEqual({ reason: "lost", grantsRevoked: 0 });
		expect(s.db.prepare("SELECT count(*) n FROM admin_session WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
		expect(s.db.prepare("SELECT close_reason FROM pairing_window").get()).toEqual({ close_reason: "restored" });
		expect(s.db.prepare("SELECT count(*) n FROM meta WHERE key IN ('cookie_secret','mrtr_key')").get()).toEqual({
			n: 2,
		});
		expect(s.db.prepare("SELECT revoked_at FROM grant_meta").get()).toEqual({ revoked_at: null });
		expect(alerts.open().map((a) => a.kind)).toEqual(["restored"]);
		expect(existsSync(flag)).toBe(false);
		expect(existsSync(restoredManifestFile(flag))).toBe(false);
		expect(s.db.prepare("SELECT 1 AS x FROM meta WHERE key = 'manifest_restart'").get()).toEqual({ x: 1 });
	});

	it("after a compromise, or to a point over an hour old, every OAuth grant ends too", async () => {
		for (const body of [
			'{"reason":"compromise","to":""}',
			JSON.stringify({ reason: "lost", to: iso(T0_MS - 2 * HOUR_MS) }),
		]) {
			const { s, alerts, flag } = await seeded();
			restoredWith(flag, body);
			expect(enterRestoredState(s, alerts, flag)?.grantsRevoked).toBe(1);
			expect(s.db.prepare("SELECT count(*) n FROM oidc_store").get()).toEqual({ n: 0 });
		}
	});

	it("refuses to start on a broken event chain or a malformed flag", async () => {
		const { s, alerts, flag } = await seeded();
		restoredWith(flag, '{"reason":"oops"}');
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(RestoreCheckFailed);
		restoredWith(flag, '{"reason":"lost","to":""}');
		// An event whose hash does not match its contents, as a tampered or torn restore would leave.
		s.db
			.prepare(
				"INSERT INTO event (id, at, actor, op, refs_json, prev_hash, hash) VALUES ('evt_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C', ?, 'system', 'test', '[]', ?, ?)",
			)
			.run(iso(T0_MS), "0".repeat(64), "f".repeat(64));
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(/event hash chain breaks/u);
		expect(existsSync(flag)).toBe(true);
	});

	it("refuses to start without the fetched manifest, or on a schema newer than the release", async () => {
		const { s, alerts, flag } = await seeded();
		writeFileSync(flag, '{"reason":"lost","to":""}');
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(/restored-manifest.json is missing/u);
		restoredWith(flag, '{"reason":"lost","to":""}');
		s.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(/schema_version 999 is newer than this release's/u);
	});

	it("starts when the chain reaches the manifest's head, and refuses a history that does not", async () => {
		const { s, alerts, flag } = await seeded();
		await addEvents(s, ["i keep bees in the garden"]);
		const manifest = buildManifest(s.db, T0_MS);
		expect(manifest.event_count).toBeGreaterThan(0);
		restoredWith(flag, '{"reason":"lost","to":""}', manifest);
		expect(enterRestoredState(s, alerts, flag)?.reason).toBe("lost");

		// A history rewritten after the manifest was stored: the same number of events ends elsewhere.
		restoredWith(flag, '{"reason":"lost","to":""}', { ...manifest, event_chain_head: "e".repeat(64) });
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(/does not reach the .* manifest's head/u);
		// A restore older than the manifest: the chain is too short to reach it.
		restoredWith(flag, '{"reason":"lost","to":""}', { ...manifest, event_count: manifest.event_count + 5 });
		expect(() => enterRestoredState(s, alerts, flag)).toThrow(/does not reach/u);
	});
});

describe("restored state and step-up tokens", () => {
	/** An import approved before the backup: its token collected or not yet collected. */
	async function approvedImport(
		collect: boolean,
	): Promise<{ s: TestStore; stepUps: StepUps; alerts: Alerts; id: string; token: string | undefined; batch: string }> {
		const { s } = await storeAt();
		const alerts = new Alerts(s, NO_OUTBOX);
		const stepUps = new StepUps(s, alerts, "https://admin.memory.example.com", () => 0.4);
		const req = stepUps.create(LOCAL_CLIENT_ID, "import", {
			source_type: "chatgpt-history",
			file_sha256: "a".repeat(64),
			item_count: 1,
			estimate_usd: 0.4,
			chars: 400,
		});
		if (!req.ok) throw new Error(req.message);
		expect(stepUps.approve(req.id, "1")).toBe("approved");
		const polled = collect ? stepUps.status(LOCAL_CLIENT_ID, req.id) : undefined;
		const token = polled?.status === "approved" ? polled.token : undefined;
		const batch = (
			s.db.prepare("SELECT import_batch_id b FROM stepup_request WHERE id = ?").get(req.id) as { b: string }
		).b;
		return { s, stepUps, alerts, id: req.id, token, batch };
	}

	/** A restore after the instance was lost, with no manifest stored yet. */
	function restore(s: TestStore, alerts: Alerts): void {
		const flag = path.join(tempDir(), "restored");
		writeFileSync(restoredManifestFile(flag), "null");
		writeFileSync(flag, '{"reason":"lost","to":""}');
		expect(enterRestoredState(s, alerts, flag)?.reason).toBe("lost");
	}

	it("S-AGENT-24: polling again after a restore hands out no new token for an approval the backup brought back", async () => {
		const { s, stepUps, alerts, id, token, batch } = await approvedImport(true);
		const upload = {
			batch_id: batch,
			items: [
				{ key: "b".repeat(64), source_item_id: "conv-1", ordinal: 0, mode: "extract", messages: ["I bake bread."] },
			],
		};
		expect(token).toBeDefined();
		expect(stepUps.consume(LOCAL_CLIENT_ID, token, "import", upload)).toBe(id);
		restore(s, alerts);
		expect(stepUps.consume(LOCAL_CLIENT_ID, token, "import", upload)).toBeUndefined();
		expect(stepUps.status(LOCAL_CLIENT_ID, id)).toEqual({ status: "approved" });
	});

	it("S-AGENT-25: an approval whose token was never collected before the backup hands out none after the restore", async () => {
		const { s, stepUps, alerts, id } = await approvedImport(false);
		restore(s, alerts);
		expect(stepUps.status(LOCAL_CLIENT_ID, id)).toEqual({ status: "approved" });
		expect(s.db.prepare("SELECT token_hash FROM stepup_request WHERE id = ?").get(id)).toEqual({ token_hash: null });
	});
});

/** Saves each sentence as the owner's words in a chat, so the store's event chain grows. */
async function addEvents(s: TestStore, sentences: readonly string[], app?: App): Promise<void> {
	const write = (app ?? testApp(s)).write;
	for (const words of sentences) {
		await save(write, chatCaller(), saveReq(words, { user_words: words }), {
			idempotencyKey: newId("pxs"),
			observedAt: T0_MS,
		});
	}
}

describe("daily manifest", () => {
	/** A store with a few events, an outbox directory, and the drop directory the outbox script fills. */
	async function awsApp(): Promise<{ s: TestStore; app: App; outbox: string; drop: string }> {
		const { s } = await storeAt();
		const outbox = tempDir();
		const drop = tempDir();
		const app = testApp(s, { outbox: new FileOutbox(outbox) });
		await addEvents(s, ["i keep bees in the garden", "i live in denver"], app);
		return { s, app, outbox, drop };
	}

	/** Plays the outbox script once the job has asked: answers the fetch request with `stored` (null: the bucket is empty). */
	async function answerFetch(outbox: string, drop: string, stored: ManifestT | null): Promise<void> {
		await answerFetchWith(outbox, drop, JSON.stringify(stored));
	}

	/** As answerFetch, with the drop file's text as given (a forged or broken file). */
	async function answerFetchWith(outbox: string, drop: string, text: string): Promise<void> {
		let request: string | undefined;
		while (!(request = readdirSync(outbox).find((f) => f.startsWith("manifest-fetch-"))))
			await new Promise((r) => setTimeout(r, 2));
		rmSync(path.join(outbox, request));
		writeFileSync(path.join(drop, `manifest-${request.slice("manifest-fetch-".length)}.json`), text);
	}

	/** The daily manifests the job handed to the outbox. */
	const written = (outbox: string): string[] =>
		readdirSync(outbox).filter((f) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/u.test(f));

	it("records the event count and chain head, which the live chain reaches", async () => {
		const { s } = await awsApp();
		const m = buildManifest(s.db, T0_MS);
		expect(m.date).toBe(iso(T0_MS).slice(0, 10));
		expect(m.store_hash).toMatch(/^[0-9a-f]{64}$/u);
		expect(chainReaches(s.db, m)).toBe(true);
		expect(chainReaches(s.db, { ...m, event_count: m.event_count - 1 })).toBe(false);
		expect(chainReaches(s.db, { event_count: 0, event_chain_head: "0".repeat(64) })).toBe(true);
	});

	it("checks the newest stored manifest, then writes today's", async () => {
		const { s, app, outbox, drop } = await awsApp();
		const earlier = buildManifest(s.db, T0_MS - 86_400_000);
		await addEvents(s, ["i drive a blue car"], app);
		for (const stored of [null, earlier]) {
			const [outcome] = await Promise.all([
				runManifestJob(app, { dropDir: drop, pollMs: 2 }),
				answerFetch(outbox, drop, stored),
			]);
			expect(outcome).toBe("written");
			const name = `manifest-${iso(T0_MS).slice(0, 10)}.json`;
			expect(JSON.parse(readFileSync(path.join(outbox, name), "utf8"))).toEqual(buildManifest(s.db, T0_MS));
			rmSync(path.join(outbox, name));
			expect(readdirSync(drop)).toEqual([]);
		}
	});

	it("raises manifest_mismatch and writes nothing when the history no longer reaches the stored head", async () => {
		const { s, app, outbox, drop } = await awsApp();
		const stored = { ...buildManifest(s.db, T0_MS), event_chain_head: "e".repeat(64) };
		const [outcome] = await Promise.all([
			runManifestJob(app, { dropDir: drop, pollMs: 2 }),
			answerFetch(outbox, drop, stored),
		]);
		expect(outcome).toBe("mismatch");
		expect(readdirSync(outbox).filter((f) => f.startsWith("manifest-"))).toEqual([]);
		expect(app.alerts.open().map((a) => [a.kind, a.details])).toEqual([
			["manifest_mismatch", { date: stored.date, event_count: stored.event_count }],
		]);
		expect(readdirSync(outbox)).toContain("alert-manifest_mismatch.json");
	});

	it("S-AWS-10: a history cut short, its head rewritten to the new last event, no longer reaches the stored head", async () => {
		const { s, app, outbox, drop } = await awsApp();
		await addEvents(s, ["i drive a blue car", "i swim on mondays"], app);
		const stored = buildManifest(s.db, T0_MS);
		// The last two events are deleted and the head set to the event before them: the chain that is left is valid.
		const tail = s.db.prepare("SELECT id FROM event ORDER BY id DESC LIMIT 2").all() as { id: string }[];
		for (const e of tail) s.db.prepare("DELETE FROM event WHERE id = ?").run(e.id);
		const head = (s.db.prepare("SELECT hash FROM event ORDER BY id DESC LIMIT 1").get() as { hash: string }).hash;
		s.db.prepare("UPDATE meta SET value = ? WHERE key = 'event_chain_head'").run(head);
		const [outcome] = await Promise.all([
			runManifestJob(app, { dropDir: drop, pollMs: 2 }),
			answerFetch(outbox, drop, stored),
		]);
		expect(outcome).toBe("mismatch");
		expect(written(outbox)).toEqual([]);
		expect(app.alerts.open().map((a) => a.kind)).toEqual(["manifest_mismatch"]);
	});

	it("S-AWS-11: a forged or broken drop file (extra field, a head that is not a hash, not JSON) writes no manifest and is removed", async () => {
		const { s, app, outbox, drop } = await awsApp();
		const m = buildManifest(s.db, T0_MS);
		for (const text of [
			JSON.stringify({ ...m, trusted: true }),
			JSON.stringify({ ...m, event_chain_head: "*" }),
			JSON.stringify({ ...m, event_count: -1 }),
			"{not json",
			"",
		]) {
			const job = runManifestJob(app, { dropDir: drop, pollMs: 2 });
			await answerFetchWith(outbox, drop, text);
			await expect(job, text).rejects.toThrow();
			expect(written(outbox)).toEqual([]);
			expect(readdirSync(drop)).toEqual([]);
		}
	});

	it("S-AWS-12: a drop file planted under another request's id is never read: the job waits for its own and writes nothing", async () => {
		const { app, outbox, drop } = await awsApp();
		writeFileSync(path.join(drop, "manifest-01JC9Z3N4V8Q2W5X7Y9Z0A1B2C.json"), "null");
		await expect(runManifestJob(app, { dropDir: drop, waitMs: 40, pollMs: 5 })).rejects.toThrow(/no manifest arrived/u);
		expect(written(outbox)).toEqual([]);
		expect(readdirSync(drop)).toEqual(["manifest-01JC9Z3N4V8Q2W5X7Y9Z0A1B2C.json"]);
	});

	it("after a restore, stores today's without comparing once, then checks again", async () => {
		const { s, app, outbox, drop } = await awsApp();
		const before = storeHash(s.db);
		restartManifests(s.db, iso(T0_MS));
		expect(storeHash(s.db)).toBe(before); // the flag is not part of the store
		// No fetch: a manifest stored after the restore point would never match.
		expect(await runManifestJob(app, { dropDir: drop, waitMs: 30, pollMs: 2 })).toBe("restarted");
		const name = `manifest-${iso(T0_MS).slice(0, 10)}.json`;
		expect(JSON.parse(readFileSync(path.join(outbox, name), "utf8"))).toEqual(buildManifest(s.db, T0_MS));
		expect(readdirSync(outbox).filter((f) => f.startsWith("manifest-fetch-"))).toEqual([]);
		rmSync(path.join(outbox, name));
		const stale = { ...buildManifest(s.db, T0_MS), event_chain_head: "e".repeat(64) };
		const [outcome] = await Promise.all([
			runManifestJob(app, { dropDir: drop, pollMs: 2 }),
			answerFetch(outbox, drop, stale),
		]);
		expect(outcome).toBe("mismatch");
	});

	it("fails, so the worker retries, when the outbox never answers", async () => {
		const { app, drop } = await awsApp();
		await expect(runManifestJob(app, { dropDir: drop, waitMs: 30, pollMs: 5 })).rejects.toThrow(/no manifest arrived/u);
	});
});

describe("maint --compact", () => {
	it("keeps every row, leaves no freed page of a deleted row in the file, and finishes an interrupted run", async () => {
		const s = await testStore();
		const file = s.file;
		const canary = `canary-${randomBytes(8).toString("hex")}`;
		s.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'kept'), ('gone', ?)").run(canary.repeat(200));
		s.db.prepare("DELETE FROM meta WHERE key = 'gone'").run();
		s.db.close();
		// A previous run that stopped after writing store.old.db.
		writeFileSync(file.replace(/\.db$/u, ".old.db"), canary);

		const before = process.umask(0o022);
		const r = (() => {
			try {
				return compactStore(file);
			} finally {
				process.umask(before);
			}
		})();
		expect(r.bytesAfter).toBeGreaterThan(0);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o660); // Litestream still writes it
		expect(readdirSync(path.dirname(file)).filter((f) => /old|new/u.test(f))).toEqual([]);
		expect(readFileSync(file).includes(canary)).toBe(false);
		const db = openStore(file, { mode: "aws" });
		expect(db.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: "kept" });
		db.close();
		rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5 });
	});

	it("zero-fills before deleting", () => {
		const file = path.join(tempDir(), "x.db");
		writeFileSync(file, "secret".repeat(1000));
		zeroAndDelete(file);
		expect(existsSync(file)).toBe(false);
	});
});

describe("aws front door", () => {
	const socketPath = (): string =>
		process.platform === "win32"
			? `\\\\.\\pipe\\ma-test-${randomBytes(6).toString("hex")}`
			: path.join(tempDir(), "http.sock");

	async function awsServer(): Promise<{ sock: string; server: Server }> {
		const s = await testStore({ memory: true });
		const dataDir = tempDir();
		mkdirSync(path.join(dataDir, "maint"));
		const config = ServerConfig.parse({
			server: {
				mode: "aws",
				listen: "unix:/run/memory-anywhere/http.sock",
				public_url: "https://memory.example.com",
				data_dir: dataDir,
			},
		});
		const app = testApp(s, { config });
		const server = createHttpServer({
			app,
			door: awsDoor(config.server.public_url),
			authenticate: NO_AUTH,
			logger: new Logger(() => undefined),
		});
		const sock = socketPath();
		await new Promise<void>((resolve) => server.listen(sock, resolve));
		cleanup.push(() => {
			server.close();
			s.close();
		});
		return { sock, server };
	}

	function get(
		sock: string,
		route: string,
		headers: Record<string, string>,
	): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: sock, path: route, method: "GET", headers }, (res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
			});
			req.on("error", reject);
			req.end();
		});
	}

	const viaCaddy = (origin: "mcp" | "admin", host: string): Record<string, string> => ({
		host,
		"x-ma-origin": origin,
		"x-forwarded-for": "203.0.113.7",
	});

	it("serves the mcp surface only with X-MA-Origin mcp on {host}", async () => {
		const { sock } = await awsServer();
		expect((await get(sock, "/v1/health", viaCaddy("mcp", "memory.example.com"))).status).toBe(200);
		expect(
			(await get(sock, "/v1/health", { host: "memory.example.com", "x-forwarded-for": "203.0.113.7" })).status,
		).toBe(403);
		expect((await get(sock, "/v1/health", viaCaddy("mcp", "admin.memory.example.com"))).status).toBe(403);
		expect(
			(await get(sock, "/v1/health", { ...viaCaddy("mcp", "memory.example.com"), "x-forwarded-for": "not an ip" }))
				.status,
		).toBe(403);
	});

	it("never serves resource routes on the admin surface (S-WEB-05) and answers 401 with resource metadata", async () => {
		const { sock } = await awsServer();
		expect((await get(sock, "/v1/health", viaCaddy("admin", "admin.memory.example.com"))).status).toBe(404);
		expect((await get(sock, "/v1/health", { ...viaCaddy("admin", "memory.example.com") })).status).toBe(403);
		const r = await get(sock, "/v1/status", viaCaddy("mcp", "memory.example.com"));
		expect(r.status).toBe(401);
		expect(r.headers["www-authenticate"]).toBe(
			'Bearer resource_metadata="https://memory.example.com/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"',
		);
	});

	it("answers the updater's health check, sent with the headers in ma-updater.sh's health_ok", async () => {
		// The updater talks to the socket directly; the server must see it as Caddy would forward it.
		const script = readFileSync(
			path.join(import.meta.dirname, "..", "..", "..", "deploy", "aws", "host", "ma-updater.sh"),
			"utf8",
		);
		const body = /^health_ok\(\) \{[^]*?^\}/mu.exec(script)?.[0] ?? "";
		const headers = Object.fromEntries(
			[...body.matchAll(/-H (["'])([^"']+)\1/gu)].map((m) => {
				const [name, ...value] = (m[2] ?? "").split(":");
				return [(name ?? "").toLowerCase(), value.join(":").trim().replace("$(site_host)", "memory.example.com")];
			}),
		);
		expect(Object.keys(headers).sort()).toEqual(["host", "x-forwarded-for", "x-ma-origin"]);
		const { sock } = await awsServer();
		expect((await get(sock, "/v1/health", headers)).status).toBe(200);
		expect((await get(sock, "/v1/health", { host: "localhost" })).status).toBe(403); // a bare request, as 0.2.0's updater sent
	});

	it("refuses a browser Origin on resource routes", async () => {
		const { sock } = await awsServer();
		expect(
			(
				await get(sock, "/v1/status", {
					...viaCaddy("mcp", "memory.example.com"),
					origin: "https://memory.example.com",
				})
			).status,
		).toBe(403);
	});
});
