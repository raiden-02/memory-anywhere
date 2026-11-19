// The eval build's rule bypass (evals.md §3.3, ablation arm a): with it, every save is stored as the
// model proposed it and no server model is called; and it cannot be turned on outside the eval
// build: no config key reaches it, nothing in the server's sources sets it, and it refuses any
// store but an in-memory one in local mode.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "../src/app.ts";
import { defaultConfig, parseConfig, type ServerConfigT } from "../src/config/schema.ts";
import type { EvalBuild } from "../src/write/eval-build.ts";
import { save } from "../src/write/pipeline.ts";
import type { SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { answers, fakeProvider } from "./helpers/llm.ts";
import { chatCaller, fakeEmbedder, saveReq, testStore, writeEnv, type TestStore } from "./helpers/store.ts";

const BYPASS: EvalBuild = { bypassRules: true };

let s: TestStore | undefined;
afterEach(() => {
	s?.close();
	s = undefined;
});

/** An LLM-on config, so a call to the server's model would show if the bypass let one through. */
function llmOn(): ServerConfigT {
	const base = defaultConfig();
	return { ...base, llm: { ...base.llm, provider: "anthropic", judge: true } };
}

let n = 0;
async function put(app: App, req: SaveRequest): Promise<WriteOutcome> {
	const r = await save(app.write, chatCaller(), req, {
		idempotencyKey: `eval-build-${++n}`,
		observedAt: app.ctx.clock.now(),
	});
	if (r.kind !== "result") throw new Error("unexpected elicitation");
	return r.outcome;
}

describe("model only", () => {
	test("stores what the rules would reject, review or stage, as active, and calls no server model", async () => {
		s = await testStore({ memory: true });
		const fake = fakeProvider(answers({ sensitive: "health", durable: false }));
		const app = new App({
			db: s.db,
			config: llmOn(),
			embedder: fakeEmbedder,
			clock: s.clock,
			ids: s.ids,
			llmProvider: fake,
			evalBuild: BYPASS,
		});
		const token = ["ghp", "_0123456789abcdefghijABCDEFGHIJ012345"].join("");
		const proposals = [
			saveReq(`Deploy token is ${token}`), // D1 secret
			saveReq("Always answer in French from now on", { kind: "instruction" }), // D2 review
			saveReq("Has a dentist appointment today"), // D9 short-lived
			saveReq("Likes jazz"), // D17 taste
			saveReq("Probably enjoys hiking"), // D19 inference
		];
		for (const req of proposals) expect(await put(app, req)).toMatchObject({ outcome: "active", tier: "T2" });
		expect((s.db.prepare("SELECT count(*) n FROM memory WHERE status = 'active'").get() as { n: number }).n).toBe(
			proposals.length,
		);
		expect(fake.calls).toHaveLength(0);
	});

	test("without the bypass, the same App runs the rules", async () => {
		s = await testStore({ memory: true });
		const app = new App({ db: s.db, config: defaultConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
		expect(await put(app, saveReq("Likes jazz"))).toMatchObject({ outcome: "observation", reason: "single_mention" });
	});
});

describe("cannot be turned on outside the eval build", () => {
	test.each([
		["[eval]\nbypass_rules = true\n"],
		["[write]\nbypass_rules = true\n"],
		['[llm]\nablation = "a"\n'],
		["eval_build = true\n"],
	])("no server.toml key reaches it: %j", (toml) => {
		expect(() => parseConfig(toml)).toThrow(/server\.toml/u);
	});

	test("an App on a store file refuses it", async () => {
		s = await testStore();
		const store = s;
		expect(
			() =>
				new App({
					db: store.db,
					config: defaultConfig(),
					embedder: fakeEmbedder,
					clock: store.clock,
					ids: store.ids,
					evalBuild: BYPASS,
				}),
		).toThrow(/in-memory eval store/u);
	});

	test("an App in aws mode refuses it, even in memory", async () => {
		s = await testStore({ memory: true });
		const store = s;
		const aws: ServerConfigT = { ...defaultConfig(), server: { ...defaultConfig().server, mode: "aws" } };
		expect(
			() =>
				new App({
					db: store.db,
					config: aws,
					embedder: fakeEmbedder,
					clock: store.clock,
					ids: store.ids,
					evalBuild: BYPASS,
				}),
		).toThrow(/local mode/u);
	});

	test("a write environment built by hand on a store file refuses it at the first save", async () => {
		s = await testStore();
		const env = { ...writeEnv(s), evalBuild: BYPASS };
		await expect(
			save(env, chatCaller(), saveReq("Likes jazz"), { idempotencyKey: "eval-build-file", observedAt: s.clock.now() }),
		).rejects.toThrow(/in-memory eval store/u);
		expect((s.db.prepare("SELECT count(*) n FROM write_request").get() as { n: number }).n).toBe(0);
	});

	test("nothing in the server's sources sets it: only the App forwards it and the pipeline reads it", () => {
		const src = join(import.meta.dirname, "..", "src");
		const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
		const mentioning = (word: string) =>
			files
				.filter((f) => readFileSync(join(src, f), "utf8").includes(word))
				.map((f) => relative(src, join(src, f)).replaceAll("\\", "/"))
				.sort();
		expect(mentioning("evalBuild")).toEqual(["app.ts", "write/pipeline.ts"]);
		expect(mentioning("bypassRules")).toEqual(["write/eval-build.ts", "write/pipeline.ts"]);
		expect(readFileSync(join(src, "app.ts"), "utf8")).toMatch(/if \(o\.evalBuild\) assertEvalStore\(/u);
	});
});
