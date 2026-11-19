// Imports (importers.md; write-path.md §10.2, §10.4, §10.5) with synthetic items only: the import
// decision rows, uploads and their idempotency, extraction with the span check, the import budget's
// stop and resume, the step-up bound to one batch, the bulk approval of sensitive items, the
// estimate, and the routes over HTTP in local and aws (step-up) mode.

import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { needsUv, runAction } from "../src/admin/owner-actions.ts";
import { reviews } from "../src/admin/views.ts";
import { App, SERVER_VERSION } from "../src/app.ts";
import { localGrant } from "../src/api/grant.ts";
import { StepUps } from "../src/auth/stepup.ts";
import { defaultConfig, type ServerConfigT } from "../src/config/schema.ts";
import { localDoor } from "../src/http/front.ts";
import { Logger } from "../src/http/log.ts";
import { createHttpServer, localHttpServer } from "../src/http/server.ts";
import { EXTRACT_PROMPT_TOKENS, type ExtractOutputT } from "../src/llm/prompts.ts";
import { HOUR_MS, DAY_MS, iso } from "../src/store/clock.ts";
import { contentHash } from "../src/store/dump.ts";
import { LOCAL_CLIENT_ID } from "../src/store/init.ts";
import { renderPage } from "../src/web/pages.ts";
import { decide, type DecideInput } from "../src/write/decide.ts";
import {
	atomicKind,
	batchStatus,
	CALL_OUTPUT_TOKENS,
	CALL_OVERHEAD_INPUT_TOKENS,
	confirmDollars,
	createBatch,
	estimate,
	ESTIMATE_MARGIN,
	IMPORT_CLIENT_ID,
	spanCheck,
	upload,
} from "../src/write/imports.ts";
import { forgetByOwner } from "../src/write/forget.ts";
import type { Resolution } from "../src/write/types.ts";
import { atomic, begin, drain, extract, FILE, freePort, sha, stepUpsFor } from "./helpers/imports.ts";
import { fakeProvider, type FakeProvider } from "./helpers/llm.ts";
import { CHAT_CLIENT_ID, T0_MS, testApp, testStore, type TestStore } from "./helpers/store.ts";

// ---- the decision rows (write-path.md §10.4)

describe("import decision rows", () => {
	const SELF: Resolution = {
		entity: { id: "ent_self", type: "self", isNew: false },
		attribute: undefined,
		slotFromLlm: false,
		sectionId: "sec_unsorted",
		isPeopleSection: false,
		tasteClass: false,
	};
	const NO = {
		secretHit: false,
		instructionHit: false,
		sensitiveCategory: undefined,
		shortLivedHit: false,
		suppressionHit: false,
	};
	const at = (o: Partial<DecideInput> = {}): DecideInput => ({
		tier: 3,
		channel: "import",
		importClass: "memory",
		kind: "fact",
		explicitRequest: false,
		supersedes: undefined,
		verified: { content: "Works as a gardener", qualifyingUserWords: false, rememberIntent: false },
		screens: NO,
		resolution: SELF,
		duplicateOf: undefined,
		floored: false,
		canElicit: false,
		elicitationAnswer: undefined,
		...o,
	});

	it("stores an item of a memory list at T3 as imported; a preference also asks the owner to confirm it", () => {
		expect(decide(at())).toEqual({ row: "I1", kind: "active", reason: "imported", tier: 3, preferenceConfirm: false });
		expect(decide(at({ kind: "preference" }))).toMatchObject({
			row: "I1",
			reason: "imported",
			preferenceConfirm: true,
		});
	});

	it("stages everything from a history or a model-written file, events included", () => {
		expect(decide(at({ importClass: "observation" }))).toEqual({
			row: "I2",
			kind: "observation",
			reason: "imported_observation",
			floored: false,
		});
		expect(decide(at({ importClass: "observation", kind: "event" })).row).toBe("I2");
	});

	it("applies D13 without user words to a listed event", () => {
		expect(decide(at({ kind: "event" }))).toMatchObject({ row: "D13", kind: "active", reason: "event" });
	});

	it("sends a sensitive fact about the owner to import review, and still rejects one about someone else", () => {
		const health = { ...NO, sensitiveCategory: "health" as const };
		expect(decide(at({ screens: health }))).toMatchObject({
			row: "D5i",
			kind: "review",
			reviewKind: "import_sensitive",
		});
		expect(decide(at({ screens: health, importClass: "observation" })).row).toBe("D5i");
		const person: Resolution = { ...SELF, entity: { id: "ent_sam", type: "person", isNew: false } };
		expect(decide(at({ screens: health, resolution: person }))).toMatchObject({
			row: "D3",
			kind: "reject",
			reason: "sensitive_third_party",
		});
	});

	it("keeps the rows before: secrets, instructions, suppressions (never elicited) and duplicates", () => {
		expect(decide(at({ screens: { ...NO, secretHit: true } })).row).toBe("D1");
		expect(decide(at({ screens: { ...NO, instructionHit: true } }))).toMatchObject({
			row: "D2",
			reviewKind: "instruction",
		});
		expect(decide(at({ screens: { ...NO, suppressionHit: true }, canElicit: true }))).toMatchObject({
			row: "D8",
			reason: "previously_forgotten",
		});
		expect(decide(at({ duplicateOf: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" })).row).toBe("D10");
	});

	it("reads a liking or a wish in a list item as a preference", () => {
		expect(atomicKind("Prefers short answers")).toBe("preference");
		expect(atomicKind("I like tea")).toBe("fact");
		expect(atomicKind("Works at a bakery")).toBe("fact");
	});
});

// ---- the span check (write-path.md §10.2)

describe("span check", () => {
	const messages = ["I moved to Porto last spring and I work at a small bakery there.", "Please keep answers short."];
	const item = (o: Partial<ExtractOutputT["items"][number]>): ExtractOutputT["items"][number] => ({
		content: "Works at a small bakery in Porto",
		kind: "fact",
		span: "I work at a small bakery",
		prompt_id: "m1",
		attribute: null,
		entity: null,
		...o,
	});

	it("keeps a fact whose span is in its message and whose words come from it", () => {
		expect(spanCheck(item({}), messages, 0.6)).toBeUndefined();
		expect(spanCheck(item({ span: "  I WORK at a small   bakery." }), messages, 0.6)).toBeUndefined(); // compared after norm()
	});

	it("keeps a fact whose span is in another message of the call than the one it cites", () => {
		expect(spanCheck(item({ prompt_id: "m2" }), messages, 0.6)).toBeUndefined();
		expect(spanCheck(item({ prompt_id: "x1" }), messages, 0.6)).toBeUndefined();
	});

	it("measures support against the call's messages together", () => {
		const two = ["I moved to Porto last spring.", "These days I work at a small bakery."];
		expect(
			spanCheck(item({ content: "Works at a small bakery in Porto", span: "I work at a small bakery" }), two, 0.6),
		).toBeUndefined();
	});

	it("drops a short span, a span in no message, and a fact the messages do not support", () => {
		expect(spanCheck(item({ span: "bakery" }), messages, 0.6)).toBe("unsupported_span");
		expect(spanCheck(item({ span: "I work at a large factory" }), messages, 0.6)).toBe("unsupported_span");
		expect(spanCheck(item({ content: "Owns three vineyards near Lisbon and sells wine" }), messages, 0.6)).toBe(
			"low_support",
		);
	});

	it("drops redacted and over-long items", () => {
		expect(spanCheck(item({ content: "Uses the key [REDACTED:api_key] at the bakery" }), messages, 0.6)).toBe(
			"redacted",
		);
		expect(spanCheck(item({ content: "a".repeat(401) }), messages, 0.6)).toBe("too_long");
	});
});

// ---- uploads, extraction and the budget, through the App

const open: { s: TestStore; servers: Server[] }[] = [];
afterEach(async () => {
	for (const o of open.splice(0)) {
		for (const server of o.servers) await new Promise((resolve) => server.close(resolve));
		o.s.close();
	}
});

function llmConfig(importCap = 50): ServerConfigT {
	const base = defaultConfig();
	return { ...base, llm: { ...base.llm, provider: "anthropic", import_usd_cap: importCap } };
}

/** A store and App with a scripted model; `clock.t` can be moved forward. */
async function setup(
	o: { importCap?: number; s?: TestStore; fake?: FakeProvider } = {},
): Promise<{ app: App; s: TestStore; fake: FakeProvider; clock: { t: number } }> {
	const s = o.s ?? (await testStore({ memory: true }));
	if (!o.s) open.push({ s, servers: [] });
	const fake = o.fake ?? fakeProvider(() => ({ items: [] }));
	const clock = { t: T0_MS };
	const app = testApp(s, { config: llmConfig(o.importCap), clock: { now: () => (clock.t += 1) }, llmProvider: fake });
	return { app, s, fake, clock };
}

const one = <T>(app: App, sql: string, ...params: string[]): T => app.ctx.db.prepare(sql).get(...params) as T;

describe("uploads", () => {
	it("stores a memory list at T3, holds a sensitive item for the owner, and makes no model call", async () => {
		const { app, fake } = await setup();
		const batch = begin(app, "claude-memory", 3);
		const items = [
			atomic("Works as a landscape gardener"),
			atomic("Prefers short answers"),
			atomic("Takes medication for asthma"),
		];
		expect(await upload(app.write, batch, items)).toEqual({ batch_id: batch, accepted: 3, already: 0, queued: 0 });
		expect(fake.calls).toHaveLength(0);

		const rows = app.ctx.db
			.prepare(
				"SELECT idempotency_key k, outcome, reason, memory_id FROM import_item ORDER BY ordinal, idempotency_key",
			)
			.all() as { k: string; outcome: string; reason: string; memory_id: string }[];
		const by = Object.fromEntries(rows.map((r) => [r.k, r]));
		expect(by[items[0]?.key ?? ""]).toMatchObject({ outcome: "active", reason: "imported" });
		expect(by[items[1]?.key ?? ""]).toMatchObject({ outcome: "active", reason: "imported" });
		expect(by[items[2]?.key ?? ""]).toMatchObject({ outcome: "review", reason: "sensitive_needs_owner" });
		const fact = by[items[0]?.key ?? ""]?.memory_id ?? "";
		expect(
			one(app, "SELECT trust_tier, tier_basis, extraction_method FROM memory_version WHERE memory_id = ?", fact),
		).toEqual({ trust_tier: 3, tier_basis: "import", extraction_method: "import" });
		expect(
			one(
				app,
				"SELECT s.client_id, s.client_class, s.import_item_key FROM memory_source ms JOIN source s ON s.id = ms.source_id WHERE ms.memory_id = ?",
				fact,
			),
		).toEqual({ client_id: IMPORT_CLIENT_ID, client_class: "import", import_item_key: items[0]?.key });
		expect(
			app.ctx.db
				.prepare("SELECT kind, json_extract(payload_json, '$.batch_id') batch FROM review_item ORDER BY kind")
				.all(),
		).toEqual([
			{ kind: "import_sensitive", batch },
			{ kind: "preference_confirm", batch: null },
		]);
		expect(one(app, "SELECT count(*) n FROM write_request WHERE op = 'import'")).toEqual({ n: 3 });
		expect(batchStatus(app.ctx, batch)).toMatchObject({
			status: "done",
			pending: 0,
			counts: { "active.imported": 2, "review.sensitive_needs_owner": 1, "items.accepted": 3 },
		});
	});

	it("records each key once: a repeated upload, or the same file in a new batch, changes no content", async () => {
		const { app } = await setup();
		const uploads = [
			{ source: "claude-memory", items: [atomic("Works as a landscape gardener"), atomic("Lives near the coast")] },
			{ source: "chatgpt-history", items: [extract(["I grow tomatoes every summer."])] },
		] as const;
		for (const u of uploads) await upload(app.write, begin(app, u.source, u.items.length), u.items);
		const hash = contentHash(app.ctx.db);
		for (const u of uploads) {
			for (const batch of [
				one<{ id: string }>(app, "SELECT id FROM import_batch WHERE source_type = ?", u.source).id,
				begin(app, u.source, u.items.length),
			]) {
				expect(await upload(app.write, batch, u.items)).toEqual({
					batch_id: batch,
					accepted: 0,
					already: u.items.length,
					queued: 0,
				});
			}
		}
		expect(contentHash(app.ctx.db)).toBe(hash);
		expect(one(app, "SELECT count(*) n FROM job WHERE kind = 'extract'")).toEqual({ n: 1 });
	});

	it("rejects a forgotten fact on re-import and a redacted secret, without storing either", async () => {
		const { app } = await setup();
		const batch = begin(app, "chatgpt-memory", 1);
		await upload(app.write, batch, [atomic("Keeps bees in the garden")]);
		forgetByOwner(app.ctx, one<{ memory_id: string }>(app, "SELECT memory_id FROM import_item").memory_id, 30);
		const next = begin(app, "claude-memory", 2);
		await upload(app.write, next, [
			atomic("Keeps bees in the garden", { key: sha("edited key") }),
			atomic("Token is [REDACTED:api_key] for the bees"),
		]);
		expect(
			app.ctx.db.prepare("SELECT outcome, reason FROM import_item WHERE batch_id = ? ORDER BY reason").all(next),
		).toEqual([
			{ outcome: "rejected", reason: "previously_forgotten" },
			{ outcome: "rejected", reason: "secret" },
		]);
	});

	it("stages a model-written file per file, dated by the item but expiring from the import, and promotes a fact from two files", async () => {
		const { app } = await setup();
		const batch = begin(app, "claude-code-auto-memory", 2);
		const first = await upload(app.write, batch, [
			atomic("Uses pnpm for every project", { group_id: "proj-a.md", date: "2021-03-04" }),
		]);
		expect(first.accepted).toBe(1);
		const obs = one<{ id: string; first_seen: string; expires_at: string; status: string }>(
			app,
			"SELECT id, first_seen, expires_at, status FROM observation",
		);
		expect(obs.first_seen.slice(0, 10)).toBe("2021-03-04");
		expect(Date.parse(obs.expires_at)).toBeGreaterThan(T0_MS + 59 * DAY_MS); // ttl_days from the import, not from 2021
		expect(one(app, "SELECT session_key FROM observation_mention")).toEqual({
			session_key: `import:${batch}:proj-a.md`,
		});

		await upload(app.write, batch, [
			atomic("Uses pnpm for every project", { key: sha("second file"), group_id: "proj-b.md", date: "2022-01-01" }),
		]);
		expect(one(app, "SELECT status FROM observation WHERE id = ?", obs.id)).toEqual({ status: "promoted" });
		expect(
			one(app, "SELECT v.valid_from, v.trust_tier FROM memory m JOIN memory_version v ON v.memory_id = m.id"),
		).toEqual({ valid_from: "2021-03-04", trust_tier: 3 });
	});

	it("refuses an unknown batch", async () => {
		const { app } = await setup();
		await expect(
			upload(app.write, "imb_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", [atomic("Works as a gardener")]),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("extraction", () => {
	const conversation = [
		"I moved to Porto last spring and I work at a small bakery there.",
		"Can you fix this regex for me?",
	];
	const answer = (): ExtractOutputT => ({
		items: [
			{
				content: "Works at a small bakery in Porto",
				kind: "fact",
				span: "I work at a small bakery",
				prompt_id: "m1",
				attribute: null,
				entity: null,
			},
			{
				content: "Owns three vineyards near Lisbon",
				kind: "fact",
				span: "three vineyards",
				prompt_id: "m1",
				attribute: null,
				entity: null,
			},
			{
				content: "Uses [REDACTED:api_key] daily",
				kind: "fact",
				span: "fix this regex",
				prompt_id: "m2",
				attribute: null,
				entity: null,
			},
		],
	});

	it("queues each extract item, then stages what passes the span check as an observation, spent from the import budget", async () => {
		const { app, fake } = await setup();
		fake.script = (call) => (call.name === "extract" ? answer() : { sensitive_category: "none" });
		const batch = begin(app, "chatgpt-history", 1);
		expect(
			await upload(app.write, batch, [extract(conversation, { group_id: "conv-7", date: "2023-05-06" })]),
		).toMatchObject({ accepted: 1, queued: 1 });
		expect(batchStatus(app.ctx, batch)).toMatchObject({ status: "running", pending: 1 });

		await drain(app);
		expect(fake.calls.map((c) => c.name)).toEqual(["extract"]);
		expect(fake.calls[0]?.user).not.toContain("REDACTED"); // only the owner's redacted messages, as given
		const status = batchStatus(app.ctx, batch);
		expect(status).toMatchObject({
			status: "done",
			pending: 0,
			counts: {
				"extract.calls": 1,
				"extract.facts": 1,
				"extract.unsupported_span": 1,
				"extract.redacted": 1,
				"observation.imported_observation": 1,
			},
		});
		expect(status?.cost_usd).toBeCloseTo((400 * 0.1 + 10 * 0.5) / 1e6, 12);
		expect(one(app, "SELECT purpose, tokens_in FROM llm_spend")).toEqual({ purpose: "import", tokens_in: 400 });
		expect(one(app, "SELECT outcome, input_json FROM import_item")).toEqual({ outcome: "extracted", input_json: null });
		expect(
			one(
				app,
				"SELECT o.content, m.session_key, m.user_words FROM observation o JOIN observation_mention m ON m.observation_id = o.id",
			),
		).toEqual({
			content: "Works at a small bakery in Porto",
			session_key: `import:${batch}:conv-7`,
			user_words: "I work at a small bakery",
		});
	});

	it("counts a conversation imported again in a new batch as the same session, and another conversation as a second", async () => {
		const { app, fake } = await setup();
		fake.script = () => answer();
		const status = () =>
			one<{ status: string; n: number }>(
				app,
				"SELECT o.status, count(m.id) n FROM observation o JOIN observation_mention m ON m.observation_id = o.id",
			);
		for (const version of ["v1", "v2"]) {
			// a re-extraction: new item keys, the same conversation
			const batch = begin(app, "claude-history", 1, sha(version));
			await upload(app.write, batch, [extract(conversation, { group_id: "conv-7", key: sha(`${version}|conv-7`) })]);
			await drain(app);
		}
		expect(status()).toEqual({ status: "open", n: 2 });
		const batch = begin(app, "claude-history", 1, sha("other"));
		await upload(app.write, batch, [extract([...conversation, "Still at the bakery."], { group_id: "conv-8" })]);
		await drain(app);
		expect(status()).toEqual({ status: "promoted", n: 3 });
	});

	it("files a fact in the section the extractor names", async () => {
		const { app, fake } = await setup();
		fake.script = () => ({
			items: [
				{
					content: "Bakes rye bread every Sunday",
					kind: "fact",
					span: "I bake rye bread",
					prompt_id: "m1",
					section: "home and life",
				},
			],
		});
		const batch = begin(app, "chatgpt-memory-summary", 1);
		await upload(app.write, batch, [
			extract(["I bake rye bread every Sunday morning."], { group_id: "summary", section_hint: "About you" }),
		]);
		await drain(app);
		expect(one(app, "SELECT s.name FROM memory m JOIN section s ON s.id = m.section_id")).toEqual({
			name: "Home and life",
		});
	});

	it("stores a vendor's memory summary like its list, and answers the same messages from the cache for free", async () => {
		const { app, fake } = await setup();
		fake.script = () => answer();
		const batch = begin(app, "chatgpt-memory-summary", 2);
		await upload(app.write, batch, [
			extract(conversation, { group_id: "summary" }),
			extract(conversation, { group_id: "summary-copy" }),
		]);
		await drain(app);
		expect(fake.calls).toHaveLength(1);
		expect(batchStatus(app.ctx, batch)).toMatchObject({
			status: "done",
			counts: { "extract.calls": 1, "extract.cached": 1, "active.imported": 1, "active.already_stored": 1 },
		});
	});

	it("stops at the import cap with the rest waiting, and a resume of the same file finishes from where it stopped", async () => {
		const first = await setup({ importCap: 0.00004 }); // one call (≈ $0.000045) reaches it
		first.fake.script = () => answer();
		const batch = begin(first.app, "chatgpt-history", 2);
		await upload(first.app.write, batch, [
			extract(conversation, { group_id: "a" }),
			extract(["I work at a small bakery in Porto, still."], { group_id: "b" }),
		]);
		await drain(first.app);
		expect(batchStatus(first.app.ctx, batch)).toMatchObject({ status: "aborted_budget", pending: 1 });
		expect(first.fake.calls).toHaveLength(1);
		expect(first.app.alerts.open().map((a) => a.kind)).toContain("llm_cap");

		expect(
			createBatch(first.app.ctx, {
				source_type: "chatgpt-history",
				file_sha256: sha("another file"),
				item_count: 2,
				estimate_usd: 0,
				resume_batch_id: batch,
			}),
		).toEqual({ ok: false, message: "that batch imported a different file" });
		// The owner raises the cap and resumes: the waiting item is queued again and the batch finishes.
		const second = await setup({ importCap: 1, s: first.s, fake: first.fake });
		expect(
			createBatch(second.app.ctx, {
				source_type: "chatgpt-history",
				file_sha256: FILE,
				item_count: 2,
				estimate_usd: 0.01,
				resume_batch_id: batch,
			}),
		).toEqual({ ok: true, batchId: batch });
		await drain(second.app);
		expect(batchStatus(second.app.ctx, batch)).toMatchObject({ status: "done", pending: 0 });
		expect(first.fake.calls).toHaveLength(2);
	});

	it("retries a failing call, then records the item as failed", async () => {
		const { app, fake, clock } = await setup();
		fake.script = () => {
			throw new Error("overloaded");
		};
		const batch = begin(app, "claude-history", 1);
		await upload(app.write, batch, [extract(conversation)]);
		for (let i = 0; i < 4; i++) {
			await drain(app);
			clock.t += 2 * HOUR_MS;
		}
		expect(fake.calls).toHaveLength(4);
		expect(one(app, "SELECT outcome, reason, input_json FROM import_item")).toEqual({
			outcome: "failed",
			reason: "extract_error",
			input_json: null,
		});
		expect(batchStatus(app.ctx, batch)).toMatchObject({ status: "done", pending: 0 });
	});
});

// ---- the estimate (write-path.md §10.5 step 1)

describe("estimate", () => {
	it("prices chars / 4 plus each call's instructions and schema, a fixed output per call, and a margin", async () => {
		const { app } = await setup({ importCap: 50 });
		const r = estimate(app.ctx, app.llm, 50, {
			source_type: "chatgpt-history",
			file_sha256: FILE,
			turns: 400,
			chars: 400_000,
			item_count: 20,
		});
		const input = Math.ceil((100_000 + 20 * (EXTRACT_PROMPT_TOKENS + CALL_OVERHEAD_INPUT_TOKENS)) * ESTIMATE_MARGIN);
		const output = Math.ceil(20 * CALL_OUTPUT_TOKENS * ESTIMATE_MARGIN);
		expect(r).toEqual({
			estimate_usd: Math.ceil(((input * 0.1 + output * 0.5) / 1e6) * 100) / 100,
			input_tokens: input,
			output_tokens: output,
			cache_hits: 0,
			import_budget_remaining_usd: 50,
		});
		expect(
			estimate(app.ctx, app.llm, 50, {
				source_type: "claude-memory",
				file_sha256: FILE,
				turns: 0,
				chars: 9000,
				item_count: 40,
			}).estimate_usd,
		).toBe(0);
	});

	it("covers the owner's first real import, which 0.3.0 estimated at half its cost", async () => {
		// 145 calls over 302,000 characters used 257,218 input and 27,923 output tokens (write-path.md §10.5).
		const { app } = await setup({ importCap: 50 });
		const r = estimate(app.ctx, app.llm, 50, {
			source_type: "claude-history",
			file_sha256: FILE,
			turns: 1450,
			chars: 302_000,
			item_count: 145,
		});
		expect(r.input_tokens).toBeGreaterThanOrEqual(257_218);
		expect(r.output_tokens).toBeGreaterThanOrEqual(27_923);
		expect(r.input_tokens).toBeLessThan(257_218 * 1.5);
	});

	it("takes off what an earlier import of the same file recorded, and reports the budget left", async () => {
		const { app, fake } = await setup();
		fake.script = () => ({ items: [] });
		const batch = begin(app, "chatgpt-history", 4);
		await upload(app.write, batch, [
			extract(["I bake bread on Sundays."], { group_id: "a" }),
			extract(["I bake rye bread."], { group_id: "b" }),
		]);
		await drain(app);
		const r = estimate(app.ctx, app.llm, 50, {
			source_type: "chatgpt-history",
			file_sha256: FILE,
			turns: 80,
			chars: 8000,
			item_count: 4,
		});
		expect(r.cache_hits).toBe(2);
		expect(r.input_tokens).toBe(
			Math.ceil((1000 + 2 * (EXTRACT_PROMPT_TOKENS + CALL_OVERHEAD_INPUT_TOKENS)) * ESTIMATE_MARGIN),
		);
		expect(r.import_budget_remaining_usd).toBe(49.99);
		expect(confirmDollars(0)).toBe(0);
		expect(confirmDollars(0.01)).toBe(1);
		expect(confirmDollars(3)).toBe(3);
		expect(confirmDollars(3.0000001)).toBe(3);
	});

	it("counts items an older extractor read as work to do again", async () => {
		const { app, fake } = await setup();
		fake.script = () => ({ items: [] });
		const batch = begin(app, "chatgpt-history", 2);
		await upload(app.write, batch, [
			extract(["I bake bread on Sundays."], { group_id: "a" }),
			extract(["I bake rye bread."], { group_id: "b" }),
		]);
		await drain(app);
		app.ctx.db.prepare("UPDATE import_item SET extractor_version = 'extract_import/1'").run();
		expect(
			estimate(app.ctx, app.llm, 50, {
				source_type: "chatgpt-history",
				file_sha256: FILE,
				turns: 2,
				chars: 40,
				item_count: 2,
			}).cache_hits,
		).toBe(0);
	});
});

// ---- step-up bound to one batch (auth-and-security.md §6.2)

/** The computer's figure (estimate_usd) is never what the page shows: the server prices `chars` itself. */
const ARGS = {
	source_type: "chatgpt-history",
	file_sha256: FILE,
	item_count: 2,
	estimate_usd: 0.01,
	chars: 8000,
} as const;

describe("import step-up", () => {
	it("shows the source, hash prefix, count, the server's estimate and the budget, and wants the estimate typed in whole dollars", async () => {
		const { app } = await setup();
		const asked: unknown[] = [];
		const stepUps = new StepUps(app.ctx, app.alerts, "https://admin.memory.example.com", (r) => (asked.push(r), 2.4));
		const req = stepUps.create(LOCAL_CLIENT_ID, "import", ARGS);
		if (!req.ok) throw new Error(req.message);
		expect(asked).toEqual([
			{ source_type: "chatgpt-history", file_sha256: FILE, turns: 0, chars: 8000, item_count: 2 },
		]);
		const view = stepUps.view(req.id);
		expect(view?.text.split("\n")).toEqual([
			`Import from "chatgpt-history".`,
			`File SHA-256 ${FILE.slice(0, 4)} ${FILE.slice(4, 8)} ${FILE.slice(8, 12)} ${FILE.slice(12, 16)}.`,
			"2 items.",
			"Estimated cost: $2.40.",
			"It stops after spending $3.",
		]);
		expect(view?.confirmDollars).toBe(3);
		const html = renderPage("approve", {
			title: "Approve command",
			page: "approve",
			signedIn: true,
			open: true,
			lines: view?.text.split("\n") ?? [],
			userCode: view?.userCode ?? "",
			needsSecondConfirm: false,
			confirmDollars: 3,
		});
		expect(html).toContain("Type the estimated cost in whole dollars, rounded up");

		expect(stepUps.approve(req.id, "2")).toBe("wrong_amount");
		expect(stepUps.approve(req.id, undefined)).toBe("wrong_amount");
		expect(stepUps.approve(req.id, " $3 ")).toBe("approved");
		const polled = stepUps.status(LOCAL_CLIENT_ID, req.id);
		expect(polled).toMatchObject({ status: "approved", token_expires_in: 3600 });
		const batch = polled?.status === "approved" ? polled.import_batch_id : undefined;
		expect(batch).toMatch(/^imb_/u);
		expect(batchStatus(app.ctx, batch ?? "")).toMatchObject({
			status: "running",
			source_type: "chatgpt-history",
			estimate_usd: 2.4,
			budget_usd: 3,
		});
	});

	it("refuses a resume of another file before the owner sees it", async () => {
		const { app } = await setup();
		const stepUps = stepUpsFor(app);
		const batch = begin(app, "chatgpt-history", 2, sha("other file"));
		expect(stepUps.create(LOCAL_CLIENT_ID, "import", { ...ARGS, resume_batch_id: batch })).toMatchObject({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	it("admits uploads to its own batch only, reusably for 60 minutes, over HTTP", async () => {
		const { app, s, clock } = await setup();
		const stepUps = stepUpsFor(app);
		const port = await freePort();
		// aws mode's shape: the PC grant has no admin scope; only an approved step-up runs owner commands.
		const server = createHttpServer({
			app,
			door: localDoor(port),
			stepUps,
			logger: new Logger(() => undefined),
			authenticate: async (req, id) =>
				req.headers.authorization === "Bearer pc"
					? localGrant(new Headers(req.headers as Record<string, string>), id, false)
					: undefined,
		});
		await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
		open.find((o) => o.s === s)?.servers.push(server);
		const post = async (path: string, body: unknown, token?: string) => {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					authorization: "Bearer pc",
					"content-type": "application/json",
					"ma-client-version": SERVER_VERSION,
					...(token ? { "ma-step-up": token } : {}),
				},
			});
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		};

		const created = await post("/v1/admin/stepup", { command: "import", args: ARGS });
		const id = String(created.body["request_id"]);
		expect(stepUps.approve(id, String(stepUps.view(id)?.confirmDollars))).toBe("approved");
		const polled = await fetch(`http://127.0.0.1:${port}/v1/admin/stepup/${id}`, {
			headers: { authorization: "Bearer pc", "ma-client-version": SERVER_VERSION },
		});
		const { token, import_batch_id: batch } = (await polled.json()) as { token: string; import_batch_id: string };
		const other = begin(app, "chatgpt-history", 1, sha("other file"));

		const items = [extract(["I work at a small bakery in Porto."])];
		expect((await post("/v1/admin/import", { batch_id: batch, items })).status).toBe(403); // no token
		expect((await post("/v1/admin/import", { batch_id: other, items }, token)).status).toBe(403); // another batch
		expect((await post("/v1/admin/import", ARGS, token)).status).toBe(403); // no batch is created with a token
		expect(await post("/v1/admin/import", { batch_id: batch, items }, token)).toEqual({
			status: 200,
			body: { batch_id: batch, accepted: 1, already: 0, queued: 1 },
		});
		expect((await post("/v1/admin/import", { batch_id: batch, items }, token)).body).toMatchObject({ already: 1 }); // reusable
		clock.t += 61 * 60_000;
		expect((await post("/v1/admin/import", { batch_id: batch, items }, token)).status).toBe(403); // expired
	});
});

// ---- the review page

describe("the review page", () => {
	it("names the project a project proposal is about", async () => {
		const { app } = await setup();
		const now = iso(T0_MS);
		app.ctx.db
			.prepare(
				"INSERT INTO entity (id, type, canonical_name, status, approved, created_at) VALUES ('ent_orrery', 'project', 'Orrery', 'active', 0, ?)",
			)
			.run(now);
		app.ctx.db
			.prepare(
				"INSERT INTO review_item (id, kind, payload_json, client_id, created_at) VALUES ('rev_orrery', 'project_proposal', ?, ?, ?)",
			)
			.run(JSON.stringify({ entity_id: "ent_orrery" }), IMPORT_CLIENT_ID, now);
		expect(reviews(app).rows.find((r) => r.id === "rev_orrery")?.content).toBe("New project: Orrery");
	});
});

// ---- bulk approval of an import's sensitive items

describe("approving an import's sensitive items at once", () => {
	it("activates every open item of that import at T3 and lets every connected app recall their categories", async () => {
		const { app } = await setup();
		app.ctx.db
			.prepare(
				`INSERT INTO client_policy (client_id, display_name, vendor, class, read, write, section_allow_json, created_at, revoked_at)
      VALUES ('cli_gone', 'Old app', 'chatgpt', 'chat', 1, 1, '["*"]', ?, ?)`,
			)
			.run(iso(T0_MS), iso(T0_MS));
		const batch = begin(app, "claude-memory", 3);
		await upload(app.write, batch, [
			atomic("Takes medication for asthma"),
			atomic("Was diagnosed with migraines"),
			atomic("Is a registered libertarian"),
		]);
		const other = begin(app, "claude-memory", 1, sha("other file"));
		await upload(app.write, other, [atomic("Goes to therapy every week")]);
		const before = reviews(app);
		expect(before.imports.map((b) => [b.batch_id, b.n])).toEqual([
			[batch, 3],
			[other, 1],
		]);
		const html = renderPage("admin-reviews", {
			title: "Review",
			page: "admin",
			csrf: "x",
			nav: [],
			active: "/reviews",
			root: "",
			local: false,
			...before,
		});
		expect(html).toContain(`value="${batch}"`);
		expect(html).toContain("Approve all 3 from claude-memory");

		// One item is rejected first; the bulk approval takes the rest.
		const [rejected] = app.ctx.db
			.prepare("SELECT r.id FROM review_item r WHERE json_extract(r.payload_json, '$.batch_id') = ? ORDER BY r.id")
			.all(batch) as { id: string }[];
		await runAction(app, "review.decide", { id: rejected?.id, approve: false });
		expect(needsUv(app, "review.approve_import", { batch_id: batch })).toBe(true);
		expect(await runAction(app, "review.approve_import", { batch_id: batch })).toMatchObject({ approved: 2 });

		const statuses = app.ctx.db
			.prepare(
				`SELECT m.status, m.sensitivity_category c, v.trust_tier FROM import_item i JOIN memory m ON m.id = i.memory_id
      JOIN memory_version v ON v.memory_id = m.id WHERE i.batch_id = ? ORDER BY c`,
			)
			.all(batch) as { status: string; c: string; trust_tier: number }[];
		expect(statuses.filter((r) => r.status === "active").every((r) => r.trust_tier === 3)).toBe(true);
		expect(statuses.map((r) => r.status).sort()).toEqual(["active", "active", "forgotten"]);
		const approved = statuses
			.filter((r) => r.status === "active")
			.map((r) => r.c)
			.sort();
		for (const client of [LOCAL_CLIENT_ID, CHAT_CLIENT_ID]) {
			const allowed = JSON.parse(
				one<{ a: string }>(app, "SELECT sensitive_allow_json a FROM client_policy WHERE client_id = ?", client).a,
			) as string[];
			expect(allowed).toEqual(expect.arrayContaining(approved));
		}
		expect(one(app, "SELECT sensitive_allow_json a FROM client_policy WHERE client_id = 'cli_gone'")).toEqual({
			a: "[]",
		});
		expect(reviews(app).imports.map((b) => b.batch_id)).toEqual([other]);
		await expect(runAction(app, "review.approve_import", { batch_id: batch })).rejects.toThrow(
			/nothing from this import/u,
		);
	});
});

// ---- the routes in local mode

describe("local mode routes", () => {
	it("starts a batch with the import arguments, uploads to it, estimates and reports progress", async () => {
		const { app, s } = await setup();
		const port = await freePort();
		const server = localHttpServer({
			app,
			port,
			localToken: "local-token-0123456789abcdefghijklmnop",
			logger: new Logger(() => undefined),
		});
		await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
		open.find((o) => o.s === s)?.servers.push(server);
		const call = async (method: string, path: string, body?: unknown) => {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				headers: {
					authorization: "Bearer local-token-0123456789abcdefghijklmnop",
					"content-type": "application/json",
					"ma-client-version": SERVER_VERSION,
				},
			});
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		};

		const est = await call("POST", "/v1/import/estimate", {
			source_type: "claude-history",
			file_sha256: FILE,
			turns: 10,
			chars: 4000,
			item_count: 1,
		});
		expect(est.status).toBe(200);
		expect(est.body["import_budget_remaining_usd"]).toBe(50);
		const started = await call("POST", "/v1/admin/import", {
			...ARGS,
			source_type: "claude-memory",
			item_count: 1,
			estimate_usd: 0,
		});
		expect(started.status).toBe(200);
		const batch = String(started.body["import_batch_id"]);
		expect(
			(
				await call("POST", "/v1/admin/import", {
					batch_id: batch,
					items: [{ ...atomic("Works as a gardener"), content: undefined }],
				})
			).body,
		).toMatchObject({ code: "INVALID_INPUT", field: "items.0.content" });
		expect(
			(await call("POST", "/v1/admin/import", { batch_id: batch, items: [atomic("Works as a gardener")] })).body,
		).toMatchObject({ accepted: 1 });
		expect((await call("GET", `/v1/import/batches/${batch}`)).body).toEqual({
			batch_id: batch,
			source_type: "claude-memory",
			status: "done",
			pending: 0,
			counts: { "active.imported": 1, "items.accepted": 1 },
			cost_usd: 0,
			estimate_usd: 0,
			budget_usd: 0,
		});
		expect((await call("GET", "/v1/import/batches/imb_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C")).status).toBe(404);
		expect(
			(await call("POST", "/v1/admin/import", { ...ARGS, resume_batch_id: "imb_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" })).status,
		).toBe(400);
	});
});
