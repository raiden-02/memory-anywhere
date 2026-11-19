// `mema import` against a scripted store (write-path.md §10.5, importers.md rules 7–8): what the
// client sends on a dry run (counts only), the 24-hour dry-run rule, the step-up for the batch, the
// chunked upload with the batch's token, progress polling, resume, and local mode.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "@memory-anywhere/contracts/paths";
import { ImportArgs, ImportEstimateRequest, ImportUploadRequest } from "@memory-anywhere/contracts/schemas/v1";
import { userDirs, type ImportItemT } from "@memory-anywhere/importers";
import type { CommandDeps } from "../src/commands.ts";
import { parseClientConfig } from "../src/config.ts";
import { chunkItems, DRY_RUN_VALID_MS, dryRunFile, importCommand, type ImportOptions } from "../src/import.ts";
import { StoreClient, StoreError } from "../src/store-client.ts";

const BATCH = "imb_01JC0000000000000000000000";

interface Call {
	readonly method: string;
	readonly route: string;
	readonly body: unknown;
	readonly stepUp: string | null;
}

/** A store that answers the import routes the way the server does, and records every call. */
function scriptedStore(o: { batchId?: string; failUploadAt?: number } = {}) {
	const calls: Call[] = [];
	const recorded = new Set<string>();
	let polls = 0;
	let uploads = 0;
	const json = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const headers = new Headers(init.headers);
		const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
		const call = { method: init.method ?? "GET", route: url.pathname, body, stepUp: headers.get("ma-step-up") };
		calls.push(call);
		const route = `${call.method} ${call.route}`;
		if (route === "POST /v1/import/estimate")
			return json(200, {
				estimate_usd: 1.25,
				input_tokens: 1000,
				output_tokens: 100,
				cache_hits: 0,
				import_budget_remaining_usd: 50,
			});
		if (route === "POST /v1/admin/stepup")
			return json(200, {
				request_id: "req1",
				user_code: "ABCD2345",
				approve_url: "https://admin.example.test/approve/req1",
				expires_in: 300,
			});
		if (route === "GET /v1/admin/stepup/req1")
			return json(200, {
				status: "approved",
				token: "tok-batch",
				import_batch_id: o.batchId ?? BATCH,
				token_expires_in: 3600,
			});
		if (route === "POST /v1/admin/import" && body && "source_type" in body)
			return json(200, { import_batch_id: o.batchId ?? BATCH });
		if (route === "POST /v1/admin/import") {
			uploads++;
			if (o.failUploadAt === uploads) return json(503, { code: "UNAVAILABLE", message: "busy" });
			const items = (body?.["items"] ?? []) as ImportItemT[];
			const already = items.filter((i) => recorded.has(i.key)).length;
			for (const i of items) recorded.add(i.key);
			return json(200, {
				batch_id: body?.["batch_id"],
				accepted: items.length - already,
				already,
				queued: items.filter((i) => i.mode === "extract").length,
			});
		}
		if (call.method === "GET" && call.route.startsWith("/v1/import/batches/")) {
			polls++;
			const running = polls < 3;
			return json(200, {
				batch_id: o.batchId ?? BATCH,
				source_type: "chatgpt-memory",
				status: running ? "running" : "done",
				pending: running ? 3 - polls : 0,
				counts: { imported: recorded.size, previously_forgotten: 1 },
				cost_usd: 0,
				estimate_usd: 1.25,
				budget_usd: 2,
			});
		}
		return json(404, { code: "NOT_FOUND", message: route });
	}) as typeof fetch;
	return { calls, fetchImpl, recorded };
}

let dir: string;
let lines: string[];
let now: number;
let input: string;

function deps(mode: "remote" | "local", fetchImpl: typeof fetch): CommandDeps {
	const config = parseClientConfig(
		`schema = 1\n[store]\nmode = "${mode}"\nurl = "https://memory.example.test"\n`,
	).config;
	const paths = resolvePaths({
		platform: process.platform as "win32",
		env: { MA_HOME: path.join(dir, "data") },
		home: dir,
	});
	return {
		paths,
		config,
		store: new StoreClient("https://memory.example.test", "pc-token", fetchImpl),
		cwd: dir,
		out: (l) => lines.push(l),
		ask: async (_q, f) => f,
		now: () => now,
		sleep: async () => undefined,
		openBrowser: async () => true,
	};
}

const run = (d: CommandDeps, o: Partial<ImportOptions>): Promise<void> =>
	importCommand(
		d,
		{ target: input, source: "chatgpt-memory", mode: "dry-run", ...o },
		userDirs(path.join(dir, "home"), {}),
	);

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "ma import "));
	mkdirSync(path.join(dir, "home"));
	lines = [];
	now = Date.parse("2026-11-15T12:00:00Z");
	input = path.join(dir, "saved memories.txt");
	writeFileSync(
		input,
		`Saved memories\nSearch memories\n${Array.from({ length: 250 }, (_, i) => `Alex fact number ${i}.`).join("\n")}\nClose dialog\n`,
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

describe("dry run", () => {
	it("sends counts only to the estimate route, prints the report, and records the input's hash", async () => {
		const s = scriptedStore();
		await run(deps("remote", s.fetchImpl), {});
		expect(s.calls.map((c) => `${c.method} ${c.route}`)).toEqual(["POST /v1/import/estimate"]);
		const body = ImportEstimateRequest.parse(s.calls[0]?.body);
		expect(body).toMatchObject({ source_type: "chatgpt-memory", turns: 0, item_count: 250 });
		expect(JSON.stringify(body)).not.toContain("Alex");
		const out = lines.join("\n");
		expect(out).toMatch(/chatgpt-memory: 1 file, sha256 [0-9a-f]{16}…/u);
		expect(out).toContain("skipped: chrome 3");
		expect(out).toContain("items:   250");
		expect(out).toContain("estimate: $1.25");
		expect(out).not.toContain("Alex fact");
		const record = JSON.parse(readFileSync(dryRunFile(deps("remote", s.fetchImpl).paths), "utf8")) as {
			runs: unknown[];
		};
		expect(record.runs).toEqual([
			{
				source_type: "chatgpt-memory",
				file_sha256: body.file_sha256,
				at: "2026-11-15T12:00:00.000Z",
				item_count: 250,
				estimate_usd: 1.25,
			},
		]);
	});

	it("checks its flags before reading anything", async () => {
		const d = deps("remote", scriptedStore().fetchImpl);
		await expect(run(d, { since: "2026-01-01" })).rejects.toThrow(/history sources only/u);
		await expect(run(d, { vendor: "grok" })).rejects.toThrow(/--source paste only/u);
		await expect(run(d, { resume: BATCH })).rejects.toThrow(/--resume goes with --commit/u);
		await expect(run(d, { source: "chatgpt-history", since: "soon" })).rejects.toThrow(/not a date/u);
		await expect(run(d, { source: "chatgpt-history", conversationMinUserTurns: 0 })).rejects.toThrow(/whole number/u);
	});
});

describe("commit", () => {
	it("is refused without a dry run of the same input in the last 24 hours (rule 7)", async () => {
		const s = scriptedStore();
		const d = deps("remote", s.fetchImpl);
		await expect(run(d, { mode: "commit" })).rejects.toThrow(/--dry-run first/u);
		await run(d, {});
		writeFileSync(input, `${readFileSync(input, "utf8")}Alex likes tea.\n`);
		await expect(run(d, { mode: "commit" })).rejects.toThrow(/--dry-run first/u);
		await run(d, {});
		now += DRY_RUN_VALID_MS + 1000;
		await expect(run(d, { mode: "commit" })).rejects.toThrow(/--dry-run first/u);
		expect(s.calls.some((c) => c.route.startsWith("/v1/admin"))).toBe(false);
	});

	it("asks for the import step-up, uploads in chunks with the batch token, polls, and reports counts", async () => {
		const s = scriptedStore();
		const d = deps("remote", s.fetchImpl);
		await run(d, {});
		const sha = ImportEstimateRequest.parse(s.calls[0]?.body).file_sha256;
		lines = [];
		now += 60 * 60 * 1000;
		await run(d, { mode: "commit" });
		const routes = s.calls.slice(1).map((c) => `${c.method} ${c.route}`);
		expect(routes).toEqual([
			"POST /v1/admin/stepup",
			"GET /v1/admin/stepup/req1",
			"POST /v1/admin/import",
			"POST /v1/admin/import",
			"POST /v1/admin/import",
			`GET /v1/import/batches/${BATCH}`,
			`GET /v1/import/batches/${BATCH}`,
			`GET /v1/import/batches/${BATCH}`,
		]);
		const stepup = s.calls[1]?.body as { command: string; args: unknown };
		expect(stepup.command).toBe("import");
		// The characters it will upload, so the server prices the import itself (write-path.md §10.5 step 2).
		const chars = ImportEstimateRequest.parse(s.calls[0]?.body).chars;
		expect(ImportArgs.parse(stepup.args)).toEqual({
			source_type: "chatgpt-memory",
			file_sha256: sha,
			item_count: 250,
			estimate_usd: 1.25,
			chars,
		});
		expect(chars).toBeGreaterThan(0);
		const uploads = s.calls.filter((c) => c.route === "/v1/admin/import");
		expect(uploads.map((u) => ImportUploadRequest.parse(u.body).items.length)).toEqual([100, 100, 50]);
		expect(uploads.every((u) => u.stepUp === "tok-batch" && (u.body as { batch_id: string }).batch_id === BATCH)).toBe(
			true,
		);
		expect(s.calls.filter((c) => c.route.startsWith("/v1/import/batches/")).every((c) => c.stepUp === null)).toBe(true);
		const out = lines.join("\n");
		expect(out).toContain("Approve this in the browser with a passkey (code ABCD2345)");
		expect(out).toContain("uploaded 250/250 (accepted 250, already 0, queued for extraction 0)");
		expect(out).toContain("extracting: 2 items left");
		expect(out).toContain(`batch ${BATCH}: done; cost $0.00 of the $1.25 estimate`);
		expect(out).toContain("read:    imported 250 · previously_forgotten 1");
		expect(out).not.toContain("Alex fact");
	});

	it("names the batch to resume when an upload fails, and a resume re-sends with already-recorded items counted", async () => {
		const s = scriptedStore({ failUploadAt: 2 });
		const d = deps("remote", s.fetchImpl);
		await run(d, {});
		const err = await run(d, { mode: "commit" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StoreError);
		expect((err as Error).message).toContain(`--commit --resume ${BATCH}`);
		lines = [];
		await run(d, { mode: "commit", resume: BATCH });
		const stepups = s.calls.filter((c) => c.route === "/v1/admin/stepup");
		expect((stepups.at(-1)?.body as { args: unknown }).args).toMatchObject({ resume_batch_id: BATCH, item_count: 250 });
		expect(lines.join("\n")).toContain("uploaded 250/250 (accepted 150, already 100, queued for extraction 0)");
	});

	it("refuses an approval for another batch than the one resumed", async () => {
		const s = scriptedStore({ batchId: "imb_01JC0000000000000000000001" });
		const d = deps("remote", s.fetchImpl);
		await run(d, {});
		await expect(run(d, { mode: "commit", resume: BATCH })).rejects.toThrow(/not imb_01JC0000000000000000000000/u);
	});

	it("in local mode opens the batch with the local token and uploads without a step-up", async () => {
		const s = scriptedStore();
		const d = deps("local", s.fetchImpl);
		await run(d, {});
		await run(d, { mode: "commit" });
		expect(s.calls.some((c) => c.route.includes("stepup"))).toBe(false);
		const [open, ...uploads] = s.calls.filter((c) => c.route === "/v1/admin/import");
		expect(ImportArgs.parse(open?.body)).toMatchObject({ item_count: 250 });
		expect(uploads).toHaveLength(3);
		expect(uploads.every((u) => u.stepUp === null)).toBe(true);
	});
});

describe("upload chunks (rule 8)", () => {
	const item = (n: number, size: number): ImportItemT => ({
		key: n.toString(16).padStart(64, "0"),
		source_item_id: `s${n}`,
		ordinal: 0,
		mode: "atomic",
		content: "x".repeat(size),
	});

	it("keeps each request to at most 100 items and 1 MiB of JSON, in order", () => {
		const items = Array.from({ length: 250 }, (_, i) => item(i, 10));
		expect(chunkItems(BATCH, items).map((c) => c.length)).toEqual([100, 100, 50]);
		const big = Array.from({ length: 10 }, (_, i) => item(i, 300));
		const chunks = chunkItems(BATCH, big, 100, 1000);
		expect(chunks.flat()).toEqual(big);
		for (const c of chunks)
			expect(Buffer.byteLength(JSON.stringify({ batch_id: BATCH, items: c }))).toBeLessThanOrEqual(1000);
		expect(chunks.length).toBeGreaterThan(3);
		expect(() => chunkItems(BATCH, [item(1, 2000)], 100, 1000)).toThrow(/over the 1000-byte upload limit/u);
	});

	it("fits the largest possible extract item (20 messages of 4,000 multi-byte characters) in one request", () => {
		const huge: ImportItemT = {
			key: "f".repeat(64),
			source_item_id: "c:m",
			ordinal: 0,
			mode: "extract",
			messages: Array.from({ length: 20 }, () => "é".repeat(4000)),
		};
		expect(chunkItems(BATCH, [huge, huge])).toHaveLength(1);
	});
});
