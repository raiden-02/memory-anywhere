// Private topics (memory-policy.md §7.1–§7.2): the owner chooses which sensitive categories are
// private. Only those are screened on save, gated on recall and kept out of the profile and
// session-start; a memory in any other category is handled like any memory.

import { newId } from "@memory-anywhere/contracts/ids";
import type { RecallInputT } from "@memory-anywhere/contracts/schemas/tools";
import { afterEach, describe, expect, it } from "vitest";
import { ActionError, needsUv, runAction } from "../src/admin/owner-actions.ts";
import { defaultConfig, type ServerConfigT } from "../src/config/schema.ts";
import type { SensitiveCategory } from "../src/policy/generated.ts";
import { buildProfile } from "../src/recall/profile.ts";
import { readPolicy, visible, type ReadPolicy, type Reader, type Visibility } from "../src/recall/reader.ts";
import { recall } from "../src/recall/recall.ts";
import { PRIVATE_TOPICS_KEY, privateCategories, setMeta } from "../src/store/meta.ts";
import { save, type WriteEnv } from "../src/write/pipeline.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { answers, fakeProvider } from "./helpers/llm.ts";
import {
	CHAT_CLIENT_ID,
	chatCaller,
	ownerCaller,
	REPO,
	saveReq,
	testApp,
	testStore,
	type TestStore,
	writeEnv,
} from "./helpers/store.ts";

const open: TestStore[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));
async function store(): Promise<TestStore> {
	const s = await testStore({ memory: true });
	open.push(s);
	return s;
}

const choose = (s: TestStore, categories: readonly SensitiveCategory[]): void =>
	setMeta(s.db, PRIVATE_TOPICS_KEY, JSON.stringify(categories));

async function put(env: WriteEnv, caller: Caller, req: SaveRequest): Promise<WriteOutcome> {
	const r = await save(env, caller, req, { idempotencyKey: newId("pxs"), observedAt: env.ctx.clock.now() });
	if (r.kind !== "result") throw new Error("unexpected elicitation");
	return r.outcome;
}
const stated = (content: string, o: Partial<SaveRequest> = {}): SaveRequest =>
	saveReq(content, { user_words: content.toLowerCase(), ...o });

/** Marks a stored memory with a category, as the screens would have while that category was private. */
const categorise = (s: TestStore, id: string | undefined, category: SensitiveCategory): void => {
	s.db.prepare("UPDATE memory SET sensitivity_category = ? WHERE id = ?").run(category, id ?? "");
};

const CHAT: Reader = { clientId: CHAT_CLIENT_ID, clientClass: "chat", repoKey: undefined, admin: false };
const CODING: Reader = { clientId: "cli_local", clientClass: "coding", repoKey: REPO, admin: false };
const ask = (query: string): RecallInputT => ({ query, scope: "any", limit: 6 });

describe("the effective private list", () => {
	it("is the config's blocked list until the owner chooses, then the owner's choice", async () => {
		const s = await store();
		const config = defaultConfig();
		expect(privateCategories(s.db, config)).toEqual(config.sensitive.blocked);
		const narrow: ServerConfigT = { ...config, sensitive: { ...config.sensitive, blocked: ["health"] } };
		expect(privateCategories(s.db, narrow)).toEqual(["health"]);

		choose(s, ["home_address", "finances"]);
		expect(privateCategories(s.db, narrow)).toEqual(["finances", "home_address"]);
		choose(s, []);
		expect(privateCategories(s.db, config)).toEqual([]);
	});

	it("ignores a category id the policy no longer has", async () => {
		const s = await store();
		setMeta(s.db, PRIVATE_TOPICS_KEY, JSON.stringify(["health", "astrology"]));
		expect(privateCategories(s.db, defaultConfig())).toEqual(["health"]);
	});
});

describe("visible()", () => {
	const policy = (o: Partial<ReadPolicy>): ReadPolicy => ({
		read: true,
		displayName: "Test chat",
		sectionAllow: "all",
		sensitiveAllow: new Set(),
		private: ["health"],
		profileEligible: true,
		budget1h: 100,
		budget24h: 100,
		repo: undefined,
		...o,
	});
	const memory = (sensitivity: SensitiveCategory | null): Visibility => ({
		scope: "global",
		sectionId: "sec_profile",
		entityId: "ent_self",
		entityType: "self",
		restricted: false,
		sensitivity,
	});
	const mentions = (named: SensitiveCategory | undefined) => (c: SensitiveCategory) => c === named;

	it("treats a memory in a category that is not private like any memory", () => {
		expect(visible(CHAT, policy({}), ["global"], memory("finances"), undefined)).toBe(true);
		expect(visible(CHAT, policy({}), ["global"], memory("finances"), mentions(undefined))).toBe(true);
	});

	it("keeps a private category behind the app's allow-list and a mention in the query", () => {
		const allowed = policy({ sensitiveAllow: new Set(["health"]) });
		expect(visible(CHAT, policy({}), ["global"], memory("health"), mentions("health"))).toBe(false);
		expect(visible(CHAT, allowed, ["global"], memory("health"), mentions(undefined))).toBe(false);
		expect(visible(CHAT, allowed, ["global"], memory("health"), undefined)).toBe(false);
		expect(visible(CHAT, allowed, ["global"], memory("health"), mentions("health"))).toBe(true);
	});
});

describe("saving", () => {
	const diabetes = (o: Partial<SaveRequest> = {}) => stated("Has type 1 diabetes", o);

	it("decides a save in a private category by rows D5–D6", async () => {
		const s = await store();
		const env = writeEnv(s);
		expect(await put(env, chatCaller(), diabetes())).toMatchObject({
			outcome: "rejected",
			reason: "sensitive_not_requested",
		});
		expect(await put(env, chatCaller(), diabetes({ explicit_request: true }))).toMatchObject({
			outcome: "review",
			reason: "sensitive_needs_owner",
		});
	});

	it("decides a save in a category that is not private by the ordinary rows, without a category", async () => {
		const s = await store();
		choose(s, ["finances"]);
		const env = writeEnv(s);
		const m = await put(env, chatCaller(), diabetes({ explicit_request: true }));
		expect(m).toMatchObject({ outcome: "active", reason: "user_stated" });
		expect(
			(s.db.prepare("SELECT sensitivity_category c FROM memory WHERE id = ?").get(m.id ?? "") as { c: unknown }).c,
		).toBeNull();
	});

	it("has the model's sensitive check add only a private category", async () => {
		const s = await store();
		choose(s, ["finances"]);
		const fake = fakeProvider(answers({ sensitive: "health" }));
		const app = testApp(s, {
			config: { ...defaultConfig(), llm: { ...defaultConfig().llm, provider: "anthropic" } },
			llmProvider: fake,
		});
		const content = "Sees Dr. Patel about the knee every Tuesday";
		expect((await put(app.write, chatCaller(), stated(content))).outcome).toBe("active");
		expect(fake.calls.map((c) => c.name)).toContain("sensitive_check");
		fake.script = answers({ sensitive: "finances" });
		expect(await put(app.write, chatCaller(), stated("Pays rent through a standing order on the first"))).toMatchObject(
			{ outcome: "rejected", reason: "sensitive_not_requested" },
		);
	});
});

describe("reading", () => {
	async function world() {
		const s = await store();
		const app = testApp(s);
		return { s, app };
	}

	it("recalls a memory in a category the owner made public without an allow-list or a mention", async () => {
		const { s, app } = await world();
		const m = await put(app.write, ownerCaller(), stated("Has type 1 diabetes"));
		expect(m.outcome).toBe("active");
		expect((await recall(app.read, CHAT, ask("type 1 diabetes"))).output.items).toEqual([]);
		choose(s, ["finances"]);
		expect((await recall(app.read, CHAT, ask("type 1 diabetes"))).output.items.map((i) => i.id)).toEqual([m.id]);
	});

	it("profiles a categorised memory only while its category is not private", async () => {
		const { s, app } = await world();
		const city = await put(app.write, chatCaller(), stated("Lives in Denver"));
		categorise(s, city.id, "home_address");
		const profile = () => buildProfile(s.db, CHAT, readPolicy(s.db, app.config, CHAT), "2026-11-10T12:00:00.000Z");
		expect(profile().output.text).not.toContain(city.id);
		choose(s, ["health"]);
		expect(profile().output.key_facts.map((i) => i.id)).toEqual([city.id]);
	});

	it("places a categorised repo memory in session-start only while its category is not private", async () => {
		const { s, app } = await world();
		const note = await put(
			app.write,
			ownerCaller(),
			stated("Runs the test suite before every push", { scope: "repo" }),
		);
		categorise(s, note.id, "health");
		app.sessions.invalidate();
		expect(app.sessions.sessionStart(app.read, CODING, "claude-code", 9000).response.context).not.toContain(note.id);
		choose(s, []);
		app.sessions.invalidate();
		expect(app.sessions.sessionStart(app.read, CODING, "claude-code", 9000).response.context).toContain(note.id);
	});
});

describe("the settings.private_topics action", () => {
	it("needs a fresh passkey and accepts only known categories", async () => {
		const s = await store();
		const app = testApp(s);
		expect(needsUv(app, "settings.private_topics", { private: ["health"] })).toBe(true);
		await expect(runAction(app, "settings.private_topics", { private: ["astrology"] })).rejects.toThrow(ActionError);
		await expect(runAction(app, "settings.private_topics", { private: "health" })).rejects.toThrow(ActionError);
		await expect(runAction(app, "settings.private_topics", {})).rejects.toThrow(ActionError);
		expect(privateCategories(s.db, app.config)).toEqual(app.config.sensitive.blocked);
	});

	it("stores the choice, records it, and drops cached session-start contexts", async () => {
		const s = await store();
		const app = testApp(s);
		app.sessions.sessionStart(app.read, CODING, "claude-code", 9000);
		expect(app.sessions.size).toBe(1);
		await runAction(app, "settings.private_topics", { private: ["home_address", "health", "health"] });
		expect(privateCategories(s.db, app.config)).toEqual(["health", "home_address"]);
		expect(app.sessions.size).toBe(0);
		const event = s.db.prepare("SELECT refs_json FROM event WHERE op = 'settings.private_topics'").get() as {
			refs_json: string;
		};
		expect(JSON.parse(event.refs_json)).toEqual({ private: ["health", "home_address"] });
	});
});
