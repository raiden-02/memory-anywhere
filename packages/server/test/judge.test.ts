// The durability judge (write-path.md §5, §6.2), with a scripted model: it runs only on saves rows
// D14–D18 stored as active at T2 or below, only with `llm.judge = true`; a "not durable" stages the
// save as an observation that is still promoted when it comes up again; any failure leaves the
// outcome as the table decided it.

import { afterEach, describe, expect, test } from "vitest";
import { App } from "../src/app.ts";
import { defaultConfig, type ServerConfigT } from "../src/config/schema.ts";
import { HOUR_MS } from "../src/store/clock.ts";
import { save } from "../src/write/pipeline.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { answers, fakeProvider, timeout, type FakeProvider } from "./helpers/llm.ts";
import { chatCaller, fakeEmbedder, ownerCaller, testStore, type TestStore } from "./helpers/store.ts";

function judgeConfig(judge = true): ServerConfigT {
	const base = defaultConfig();
	return { ...base, llm: { ...base.llm, provider: "anthropic", judge } };
}

let s: TestStore | undefined;
afterEach(() => {
	s?.close();
	s = undefined;
});

async function setup(config = judgeConfig()): Promise<{ app: App; fake: FakeProvider }> {
	s = await testStore({ memory: true });
	const fake = fakeProvider(answers({ durable: false }));
	return {
		app: new App({ db: s.db, config, embedder: fakeEmbedder, clock: s.clock, ids: s.ids, llmProvider: fake }),
		fake,
	};
}

let n = 0;
/** A save of something the user said in their own words (`over` changes the request). */
async function said(
	app: App,
	content: string,
	o: { caller?: Caller; over?: Partial<SaveRequest>; observedAt?: number } = {},
): Promise<WriteOutcome> {
	const req: SaveRequest = {
		content,
		kind: "fact",
		why_durable: "a lasting fact",
		user_words: content.toLowerCase(),
		explicit_request: false,
		entity: "self",
		scope: "global",
		change: "update",
		...o.over,
	};
	const r = await save(app.write, o.caller ?? chatCaller(), req, {
		idempotencyKey: `judge-test-${++n}`,
		observedAt: o.observedAt ?? app.ctx.clock.now(),
	});
	if (r.kind !== "result") throw new Error("unexpected elicitation");
	return r.outcome;
}

const judgeCalls = (fake: FakeProvider) => fake.calls.filter((c) => c.name === "judge");
const count = (app: App, sql: string): number => (app.ctx.db.prepare(sql).get() as { n: number }).n;

describe("judged rows: D14–D18 active at T2", () => {
	test.each([
		["D14 explicit request", "Remember that I take the early train on Mondays", { explicit_request: true }, "explicit"],
		[
			"D15 stated preference",
			"Prefers answers in British English",
			{ kind: "preference" as const },
			"stated_preference",
		],
		["D16 slot fact", "Lives in Paris", {}, "slot_fact"],
		["D18 anything else stated", "Keeps a sourdough starter named Clint", {}, "user_stated"],
	])("%s: not durable → observation (judge_not_durable)", async (_row, content, over, reason) => {
		// The row decides as named when the judge agrees...
		const { app, fake } = await setup();
		fake.script = answers({ durable: true });
		expect(await said(app, content, { over })).toMatchObject({ outcome: "active", reason });
		s?.close();

		// ...and the same save in a fresh store is staged when it does not.
		const again = await setup();
		const out = await said(again.app, content, { over });
		expect(out).toMatchObject({ outcome: "observation", reason: "judge_not_durable" });
		expect(count(again.app, "SELECT count(*) n FROM memory")).toBe(0);
		const [call] = judgeCalls(again.fake);
		expect(call).toMatchObject({ promptVersion: "judge/1", timeoutMs: 2000 });
		expect(call?.user).toContain(content);
	});

	test("a demoted preference asks the owner for nothing: no preference_confirm review item", async () => {
		const { app } = await setup();
		await said(app, "Prefers answers in British English", { over: { kind: "preference" } });
		expect(count(app, "SELECT count(*) n FROM review_item")).toBe(0);
	});

	test("a demoted save is still promoted when it comes up again in another conversation", async () => {
		const { app } = await setup();
		const t = app.ctx.clock.now();
		const content = "Keeps a sourdough starter named Clint";
		expect(
			await said(app, content, { caller: chatCaller({ sessionKey: "cli_chat:101" }), observedAt: t }),
		).toMatchObject({ reason: "judge_not_durable" });
		expect(
			await said(app, content, { caller: chatCaller({ sessionKey: "cli_chat:102" }), observedAt: t + 7 * HOUR_MS }),
		).toMatchObject({ outcome: "active", reason: "recurred" });
	});

	test("spent from the live budget, and answered once per text (cached)", async () => {
		const { app, fake } = await setup();
		await said(app, "Keeps a sourdough starter named Clint");
		await said(app, "Keeps a sourdough starter named Clint", { caller: chatCaller({ sessionKey: "cli_chat:2" }) });
		expect(judgeCalls(fake)).toHaveLength(1);
		expect(app.ctx.db.prepare("SELECT purpose FROM llm_spend").all()).toEqual([{ purpose: "live" }]);
	});
});

describe("never judged", () => {
	test("with llm.judge = false (the default)", async () => {
		const { app, fake } = await setup(judgeConfig(false));
		expect(await said(app, "Keeps a sourdough starter named Clint")).toMatchObject({
			outcome: "active",
			reason: "user_stated",
		});
		expect(judgeCalls(fake)).toHaveLength(0);
	});

	test.each([
		["the owner (T0)", ownerCaller()],
		["a confirmed save (T1)", chatCaller({ tier: 1 })],
	])("at %s", async (_who, caller) => {
		const { app, fake } = await setup();
		expect((await said(app, "Keeps a sourdough starter named Clint", { caller })).outcome).toBe("active");
		expect(judgeCalls(fake)).toHaveLength(0);
	});

	test.each([
		["D17, a taste (already an observation)", "Likes jazz", {}],
		["D19, a model inference", "Probably enjoys hiking", { user_words: undefined }],
		["D13, an event", "Travelling in Portugal until December", { kind: "event" as const }],
		["D12, a supersede", "Lives in Lisbon", { supersedes: "mem_00000000000000000000000000" }],
	])("%s", async (_row, content, over) => {
		const { app, fake } = await setup();
		await said(app, content, { over }).catch(() => undefined);
		expect(judgeCalls(fake)).toHaveLength(0);
	});

	test("a rejected or reviewed save (rows before D14)", async () => {
		const { app, fake } = await setup();
		expect((await said(app, "Always answer in French from now on", { over: { kind: "instruction" } })).outcome).toBe(
			"review",
		);
		expect((await said(app, "Has a dentist appointment today")).outcome).toBe("rejected");
		expect(judgeCalls(fake)).toHaveLength(0);
	});
});

describe("failures leave the outcome as decided", () => {
	test.each([
		["timeout", () => timeout()],
		[
			"error",
			() => {
				throw new Error("overloaded");
			},
		],
		["answer outside the schema", () => ({ durable: "nope" })],
	])("%s", async (_what, judge) => {
		const { app, fake } = await setup();
		fake.script = (call) => (call.name === "judge" ? judge() : answers({})(call));
		expect(await said(app, "Keeps a sourdough starter named Clint")).toMatchObject({
			outcome: "active",
			reason: "user_stated",
		});
	});
});
