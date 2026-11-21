// Provider ollama (write-path.md §6.2): a local model, no key, called over Ollama's HTTP API with
// the call's JSON schema; spend is counted at $0 through the same adapter as the Anthropic path.
// A recorded `fetch` stands in for Ollama: no network, no model.

import { afterEach, describe, expect, test } from "vitest";
import { defaultConfig, parseConfig, type ServerConfigT } from "../src/config/schema.ts";
import { DEFAULT_OLLAMA_ENDPOINT, Llm, ollamaProvider, priceOf, providerFromEnv } from "../src/llm/adapter.ts";
import { durabilityJudge, sensitiveCheck } from "../src/llm/prompts.ts";
import { testStore, type TestStore } from "./helpers/store.ts";

interface Sent {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

/** A stand-in for Ollama: `show` answers /api/show, `chat` answers /api/chat (a Response or a thrown error). */
function fakeOllama(o: { show?: () => Response; chat: (body: Record<string, unknown>) => Response }): {
	fetch: typeof fetch;
	sent: Sent[];
} {
	const sent: Sent[] = [];
	const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push({ url, body });
		if (url.endsWith("/api/show"))
			return (o.show ?? (() => Response.json({ capabilities: ["completion"], details: { family: "mistral3" } })))();
		return o.chat(body);
	};
	return { fetch: fake as typeof fetch, sent };
}

const GPT_OSS = () =>
	Response.json({ capabilities: ["completion", "tools", "thinking"], details: { family: "gpt-oss" } });
const reply = (content: string, tokens = { prompt_eval_count: 120, eval_count: 30 }) =>
	Response.json({ message: { role: "assistant", content }, done: true, done_reason: "stop", ...tokens });

function ollamaConfig(over: Partial<ServerConfigT["llm"]> = {}): ServerConfigT {
	const base = defaultConfig();
	return { ...base, llm: { ...base.llm, provider: "ollama", model: "gpt-oss:20b", ...over } };
}

const signal = () => AbortSignal.timeout(2000);

describe("the provider", () => {
	test("sends the call's schema, both messages and the least thinking gpt-oss allows; reads the answer and tokens", async () => {
		const o = fakeOllama({ show: GPT_OSS, chat: () => reply('{"sensitive_category":"health"}') });
		const p = ollamaProvider({ endpoint: "http://127.0.0.1:11434/", model: "gpt-oss:20b", fetch: o.fetch });
		const call = sensitiveCheck("Takes insulin twice a day");
		expect(p.modelId).toBe("ollama/gpt-oss:20b");
		expect(await p.ask(call, signal())).toEqual({
			value: { sensitive_category: "health" },
			tokensIn: 120,
			tokensOut: 30,
		});

		expect(o.sent.map((x) => x.url)).toEqual(["http://127.0.0.1:11434/api/show", "http://127.0.0.1:11434/api/chat"]);
		const chat = o.sent[1]?.body ?? {};
		expect(chat).toMatchObject({ model: "gpt-oss:20b", stream: false, think: "low", options: { temperature: 0 } });
		expect(chat["messages"]).toEqual([
			{ role: "system", content: call.system },
			{ role: "user", content: call.user },
		]);
		expect(chat["format"]).toMatchObject({
			type: "object",
			properties: { sensitive_category: { enum: expect.arrayContaining(["none", "health"]) } },
			required: ["sensitive_category"],
		});
		// A thinking model's output limit would cut its answer off: the call's time limit bounds it.
		expect(chat["options"]).not.toHaveProperty("num_predict");
	});

	test("a model that can stop thinking is told to; one that never thinks gets the output limit and no think field", async () => {
		const thinker = fakeOllama({
			show: () => Response.json({ capabilities: ["completion", "thinking"], details: { family: "qwen3" } }),
			chat: () => reply('{"durable":true}'),
		});
		await ollamaProvider({ endpoint: DEFAULT_OLLAMA_ENDPOINT, model: "qwen3:8b", fetch: thinker.fetch }).ask(
			durabilityJudge({ content: "x", kind: "fact" }),
			signal(),
		);
		expect(thinker.sent[1]?.body).toMatchObject({ think: false });

		const plain = fakeOllama({ chat: () => reply('{"durable":true}') });
		await ollamaProvider({ endpoint: DEFAULT_OLLAMA_ENDPOINT, model: "mistral-small", fetch: plain.fetch }).ask(
			durabilityJudge({ content: "x", kind: "fact" }),
			signal(),
		);
		expect(plain.sent[1]?.body).not.toHaveProperty("think");
		expect(plain.sent[1]?.body["options"]).toEqual({ temperature: 0, num_predict: 16 });
	});

	test("reads the model's capabilities once, and again after a failure (Ollama started after the server)", async () => {
		let up = false;
		const o = fakeOllama({
			show: () => (up ? GPT_OSS() : new Response("connection refused", { status: 503 })),
			chat: () => reply('{"durable":true}'),
		});
		const p = ollamaProvider({ endpoint: DEFAULT_OLLAMA_ENDPOINT, model: "gpt-oss:20b", fetch: o.fetch });
		const call = durabilityJudge({ content: "x", kind: "fact" });
		await expect(p.ask(call, signal())).rejects.toThrow(/HTTP 503/u);
		up = true;
		await p.ask(call, signal());
		await p.ask(call, signal());
		expect(o.sent.map((x) => x.url.split("/api/")[1])).toEqual(["show", "show", "chat", "chat"]);
	});

	test.each([
		["an HTTP error", () => new Response("model not found", { status: 404 }), /HTTP 404/u],
		["text that is not JSON", () => reply("yes, it is durable"), /no structured answer/u],
		["JSON outside the schema", () => reply('{"durable":"maybe"}'), /outside the schema/u],
	])("throws on %s", async (_what, chat, error) => {
		const o = fakeOllama({ chat });
		await expect(
			ollamaProvider({ endpoint: DEFAULT_OLLAMA_ENDPOINT, model: "m", fetch: o.fetch }).ask(
				durabilityJudge({ content: "x", kind: "fact" }),
				signal(),
			),
		).rejects.toThrow(error);
	});
});

describe("through the adapter", () => {
	let s: TestStore | undefined;
	afterEach(() => {
		s?.close();
		s = undefined;
	});

	async function llmWith(chat: (body: Record<string, unknown>) => Response, config = ollamaConfig()): Promise<Llm> {
		s = await testStore({ memory: true });
		const provider = ollamaProvider({
			endpoint: DEFAULT_OLLAMA_ENDPOINT,
			model: config.llm.model,
			fetch: fakeOllama({ show: GPT_OSS, chat }).fetch,
		});
		return new Llm({ ctx: s, config, provider });
	}

	test("costs $0 but counts its tokens, and caches under its own model id", async () => {
		const llm = await llmWith(() => reply('{"sensitive_category":"none"}'));
		expect(await llm.ask(sensitiveCheck("Likes rain"))).toEqual({
			ok: true,
			value: { sensitive_category: "none" },
			usd: 0,
		});
		const db = s?.db;
		expect(db?.prepare("SELECT purpose, usd, tokens_in, tokens_out FROM llm_spend").all()).toEqual([
			{ purpose: "live", usd: 0, tokens_in: 120, tokens_out: 30 },
		]);
		expect(db?.prepare("SELECT model_id FROM extraction_cache").all()).toEqual([{ model_id: "ollama/gpt-oss:20b" }]);
		expect(llm.available).toBe(true);
		expect(llm.degraded()).toBeUndefined();
	});

	test("a cap of 0 still turns it off", async () => {
		const llm = await llmWith(() => reply('{"sensitive_category":"none"}'), ollamaConfig({ daily_usd_cap: 0 }));
		expect(await llm.ask(sensitiveCheck("Likes rain"))).toEqual({ ok: false, why: "cap" });
	});

	test.each([
		[
			"a timeout",
			() => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
			"timeout",
		],
		[
			"Ollama down",
			() => {
				throw new TypeError("fetch failed");
			},
			"error",
		],
		["an answer outside the schema", () => reply('{"sensitive_category":"weather"}'), "error"],
	])("%s falls back like any provider", async (_what, chat, why) => {
		const llm = await llmWith(chat);
		expect(await llm.ask(sensitiveCheck("Likes rain"))).toEqual({ ok: false, why });
	});
});

describe("config", () => {
	test("provider ollama needs no key, defaults to Ollama's own address, and is free", async () => {
		const p = await providerFromEnv(ollamaConfig(), {});
		expect(p?.modelId).toBe("ollama/gpt-oss:20b");
		expect(priceOf("ollama/gpt-oss:20b")).toEqual({ input_per_mtok: 0, output_per_mtok: 0 });
		expect(
			parseConfig('[llm]\nprovider = "ollama"\nmodel = "gpt-oss:20b"\nendpoint = "http://gpu.example.com:11434"\n').llm,
		).toMatchObject({ provider: "ollama", endpoint: "http://gpu.example.com:11434" });
	});

	test("names the model, and an endpoint is an http(s) URL", () => {
		expect(() => parseConfig('[llm]\nprovider = "ollama"\n')).toThrow(/llm\.model: provider ollama needs model/u);
		expect(() => parseConfig('[llm]\nprovider = "ollama"\nmodel = "m"\nendpoint = "ftp://127.0.0.1:11434"\n')).toThrow(
			/endpoint/u,
		);
	});
});
