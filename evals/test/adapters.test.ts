// The external baselines (evals.md §7, §8.1): how their replies are read, how an adapter becomes a
// suite R ranking, and, with MA_TEST_DOCKER=1 (Docker running, and for mem0 the host's Ollama with
// the pinned models), the real containers end to end.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	supportedSuites,
	type ExternalAdapter,
	type MemoryAdapter,
	type Recalled,
	type Saved,
	type SaveFact,
} from "../adapters/contract.ts";
import { buildContextHash, runArgs } from "../adapters/docker.ts";
import { contentHash, McpMemoryServiceAdapter, parseSearch, parseStore } from "../adapters/mcp-memory-service.ts";
import { JsonLinesChannel, Mem0Adapter } from "../adapters/mem0.ts";
import type { Doc } from "../harness/lme.ts";
import { adapterSystem, EXTERNAL_SYSTEMS, isExternalSystem } from "../harness/systems.ts";

// Replies recorded from mcp-memory-service 12.7.0.
const BEAGLE = "user: I adopted a beagle named Max.\nassistant: Congrats!";
const BEAGLE_HASH = "5d13c1f8b3f9bed7e847645de58937441a8920ed94b582ae5ea157dae5723666";
const PASTA = "user: My favorite pasta is cacio e pepe.";
const PASTA_HASH = "6c38d5ddca7aac7018619a3a1f117c9fac8ecbdecbcfa722c8d55b4621bae524";
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

describe("mcp-memory-service replies", () => {
	it("computes the service's own content hash", () => {
		expect(contentHash(BEAGLE)).toBe(BEAGLE_HASH);
		expect(contentHash(`  ${PASTA.toUpperCase()}\n`)).toBe(PASTA_HASH);
	});

	it("reads a stored hash, and names the memory an exact duplicate met", () => {
		expect(parseStore(text(`Memory stored successfully (hash: ${BEAGLE_HASH})`), BEAGLE)).toEqual({
			id: BEAGLE_HASH,
			outcome: "stored",
		});
		expect(parseStore(text("Error storing memory: Duplicate content detected (exact match)", true), BEAGLE)).toEqual({
			id: BEAGLE_HASH,
			outcome: "duplicate",
		});
		expect(
			parseStore(
				text(`Error storing memory: Duplicate content detected (semantically similar to ${PASTA_HASH})`, true),
				BEAGLE,
			),
		).toEqual({ outcome: "semantic duplicate" });
	});

	it("throws on any other failure instead of reporting a save", () => {
		expect(() => parseStore(text("Error storing memory: database is locked", true), BEAGLE)).toThrow(
			/database is locked/u,
		);
	});

	it("reads a ranked list, multi-line contents included, in order", () => {
		const reply = [
			"Found 2 memories (mode: semantic) for query: 'what dog do I have?'",
			"",
			`1. ${BEAGLE}`,
			`   Hash: ${BEAGLE_HASH}`,
			"   Created: 2026-11-19T17:53:21.097233Z [ma-eval]",
			"",
			`2. ${PASTA}\n\n3. not an entry, part of the content`,
			`   Hash: ${PASTA_HASH}`,
			"   Created: 2026-11-19T17:53:21.189380Z [ma-eval]",
		].join("\n");
		expect(parseSearch(reply)).toEqual([
			{ id: BEAGLE_HASH, content: BEAGLE },
			{ id: PASTA_HASH, content: `${PASTA}\n\n3. not an entry, part of the content` },
		]);
	});

	it("reads 'no memories' as an empty ranking", () => {
		expect(parseSearch("No memories found for query: 'what dog do I have?'")).toEqual([]);
	});
});

/** A child process whose other end the test plays. */
function fakeChild() {
	const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
	const requests: unknown[] = [];
	child.stdin.on("data", (b: Buffer) => {
		for (const line of b.toString().split("\n").filter(Boolean)) requests.push(JSON.parse(line));
	});
	const reply = (r: unknown) => child.stdout.write(JSON.stringify(r) + "\n");
	return { child, requests, reply };
}

describe("mem0 driver channel", () => {
	it("answers requests in order and turns a failed one into a rejection", async () => {
		const { child, requests, reply } = fakeChild();
		const channel = new JsonLinesChannel(child as never);
		const a = channel.request({ op: "search", query: "dog" });
		const b = channel.request({ op: "delete", id: "x" });
		reply({ ok: true, result: [{ id: "m1" }] });
		reply({ ok: false, error: "ValueError: no memory x" });
		await expect(a).resolves.toEqual([{ id: "m1" }]);
		await expect(b).rejects.toThrow(/no memory x/u);
		expect(requests).toEqual([
			{ op: "search", query: "dog" },
			{ op: "delete", id: "x" },
		]);
	});

	it("fails what is pending, and everything after, when the driver exits", async () => {
		const { child } = fakeChild();
		const channel = new JsonLinesChannel(child as never);
		const pending = channel.request({ op: "reset" });
		child.emit("exit", 1);
		await expect(pending).rejects.toThrow(/exited \(code 1\)/u);
		await expect(channel.request({ op: "reset" })).rejects.toThrow(/exited/u);
	});
});

describe("docker plumbing", () => {
	it("changes the image tag when any build file changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "ma-ctx-"));
		try {
			writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
			writeFileSync(join(dir, "requirements.txt"), "a==1\n");
			const before = buildContextHash(dir);
			expect(buildContextHash(dir)).toBe(before);
			writeFileSync(join(dir, "requirements.txt"), "a==2\n");
			expect(buildContextHash(dir)).not.toBe(before);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("keeps a container's state in memory and passes its settings as env", () => {
		const args = runArgs("img:1", "box", { OLLAMA_URL: "http://host.docker.internal:11434" });
		expect(args.slice(0, 5)).toEqual(["run", "--rm", "--interactive", "--name", "box"]);
		expect(args).toContain("/data");
		expect(args.join(" ")).toContain("--env OLLAMA_URL=http://host.docker.internal:11434");
		expect(args.at(-1)).toBe("img:1");
	});
});

describe("capabilities", () => {
	it("reports W and I as n/a for both external systems, R as scored", () => {
		for (const caps of Object.values(EXTERNAL_SYSTEMS))
			expect(supportedSuites(caps)).toEqual({ R: true, W: false, I: false });
		expect(isExternalSystem("mem0") && isExternalSystem("mcp-memory-service")).toBe(true);
		expect(isExternalSystem("memory-anywhere") || isExternalSystem("toString")).toBe(false);
	});
});

/** An in-memory system: exact-content dedup, word-overlap recall, and switches for failures. */
class FakeAdapter implements MemoryAdapter {
	readonly name = "fake";
	resets = 0;
	failSaveOf = new Set<string>();
	failRecall = false;
	readonly sessions: string[] = [];
	private store = new Map<string, string>();

	capabilities() {
		return { supersede: false, bitemporal: false, outcomes: false };
	}
	async reset(): Promise<void> {
		this.resets++;
		this.store.clear();
	}
	async save(fact: SaveFact, ctx: { session: string }): Promise<Saved> {
		this.sessions.push(ctx.session);
		if (this.failSaveOf.has(fact.content)) throw new Error("refused");
		const id = `id:${fact.content}`;
		const outcome = this.store.has(id) ? "duplicate" : "stored";
		this.store.set(id, fact.content);
		return { id, outcome };
	}
	async recall(query: string, k: number): Promise<Recalled[]> {
		if (this.failRecall) throw new Error("down");
		const words = query.split(" ");
		return [...this.store]
			.filter(([, c]) => words.some((w) => c.includes(w)))
			.slice(0, k)
			.map(([id, content]) => ({ id, content }));
	}
	async forget(id: string): Promise<void> {
		this.store.delete(id);
	}
}

describe("an adapter as a suite R ranking", () => {
	const docs: Doc[] = [
		{ id: "s1#0", text: "user: I have a beagle", date: "2023/05/20 (Sat) 02:21" },
		{ id: "s1#1", text: "user: I like pasta" },
		{ id: "s2#0", text: "user: I have a beagle" },
	];

	it("saves each round into an emptied store and maps recalled memories back to rounds", async () => {
		const fake = new FakeAdapter();
		const system = adapterSystem(fake);
		expect(await system.rank(docs, "beagle")).toEqual(["s1#0", "s2#0"]);
		expect(await system.rank(docs, "pasta")).toEqual(["s1#1"]);
		expect(fake.resets).toBe(2);
		expect(fake.sessions.slice(0, 3)).toEqual(["s1", "s1", "s2"]);
		expect(system.info?.()).toMatchObject({
			recall_k: 10,
			counts: { questions: 2, rounds: 6, not_stored: 0, failed_saves: 0, failed_recalls: 0 },
		});
	});

	it("counts a refused save or recall as a miss and goes on", async () => {
		const fake = new FakeAdapter();
		fake.failSaveOf.add("user: I like pasta");
		const lines: string[] = [];
		const system = adapterSystem(fake, (l) => lines.push(l));
		expect(await system.rank(docs, "pasta")).toEqual([]);
		fake.failRecall = true;
		expect(await system.rank(docs, "beagle")).toEqual([]);
		expect(system.info?.()).toMatchObject({ counts: { failed_saves: 2, failed_recalls: 1 } });
		expect(lines.some((l) => l.includes("save of s1#1 failed"))).toBe(true);
	});
});

// ---- the real containers (opt-in: slow, and they need Docker; mem0 also needs Ollama)

const docker = process.env["MA_TEST_DOCKER"] === "1";
const ctx = { client: "cli_eval", session: "s1", at: "2026-11-19T00:00:00.000Z" };

/** The contract's round trip, the same for every system. */
function contractCases(start: () => Promise<ExternalAdapter>) {
	let adapter: ExternalAdapter;
	beforeAll(async () => {
		adapter = await start();
	}, 600_000);
	afterAll(async () => adapter?.close());

	it("saves, recalls best first, forgets and resets", async () => {
		await adapter.reset();
		const dog = await adapter.save({ content: BEAGLE }, ctx);
		const pasta = await adapter.save({ content: PASTA }, ctx);
		expect(dog.id).toBeTruthy();
		expect(pasta.id).toBeTruthy();
		const hits = await adapter.recall("what dog do I have?", 5, ctx);
		expect(hits[0]?.id).toBe(dog.id);
		await adapter.forget(dog.id as string);
		expect((await adapter.recall("what dog do I have?", 5, ctx)).map((h) => h.id)).not.toContain(dog.id);
		await adapter.reset();
		expect(await adapter.recall("pasta", 5, ctx)).toEqual([]);
		// A reset deletes; the same content can be saved again afterwards.
		expect((await adapter.save({ content: PASTA }, ctx)).id).toBeTruthy();
	}, 120_000);

	it("replaces a memory when a save supersedes it", async () => {
		await adapter.reset();
		const old = await adapter.save({ content: "user: I live in Lisbon." }, ctx);
		const next = await adapter.save({ content: "user: I live in Denver now.", supersedes: old.id as string }, ctx);
		expect(next.outcome).toBe("updated");
		const hits = await adapter.recall("where do I live?", 5, ctx);
		expect(hits.map((h) => h.content).join("\n")).toContain("Denver");
		expect(hits.map((h) => h.content).join("\n")).not.toContain("Lisbon");
	}, 120_000);

	it("names its pinned versions", () => {
		expect(JSON.stringify(adapter.describe())).toMatch(/"image_id":"sha256:[0-9a-f]{64}"/u);
	});
}

describe.runIf(docker)("mcp-memory-service 12.7.0 in Docker", () => {
	contractCases(() => McpMemoryServiceAdapter.start());
});

describe.runIf(docker)("mem0 2.2.1 in Docker, raw mode", () => {
	contractCases(() => Mem0Adapter.start({ infer: false }));
});
