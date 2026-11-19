// mem0 OSS as a baseline (evals.md §7, §8.1): mem0ai 2.2.1 in a local Docker container, driven
// through its Python API by mem0/driver.py over a JSON-lines pipe. Its LLM and its embedder are
// the host's Ollama (no API keys), its vector store is its default
// in-process Qdrant, and its search is its own: semantic, BM25 and entity boosts fused, threshold 0.1.
//
//   adapter ──JSON lines──► docker run mem0 ──► mem0.Memory ──HTTP──► Ollama on the host
//
// Two write modes:
//   infer: true   mem0's write path: the LLM extracts facts from the text, each stored as a memory
//   infer: false  the text is stored as one memory, embedded as is (mem0's own raw mode)
// Suite R uses infer: false: every system indexes the same rounds (evals.md §3.2), and LLM
// extraction over LongMemEval-S's 124,358 rounds is days of local inference.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	Capabilities,
	ExternalAdapter,
	Recalled,
	RecallCtx,
	SaveCtx,
	Saved,
	SaveFact,
	SystemInfo,
} from "./contract.ts";
import { containerName, ensureImage, removeContainer, runArgs } from "./docker.ts";

export const MEM0_VERSION = "2.2.1";
/** Ollama models, pinned by digest at run time (describe().ollama_digests). */
export const MEM0_LLM = "gpt-oss:20b";
export const MEM0_EMBEDDER = "nomic-embed-text";
export const MEM0_EMBED_DIMS = 768;
/**
 * mem0 2.x updates a memory in place by id (Memory.update), keeping the old text only in its
 * history table; nothing is recalled as of a past time; a save reports ADD or nothing.
 */
export const MEM0_CAPABILITIES: Capabilities = { supersede: true, bitemporal: false, outcomes: false };
/** The one user every memory belongs to (the synthetic persona of evals.md §1). */
const USER = "alex";

export interface Mem0Options {
	/** Let mem0's LLM extract facts on save (its default), or store the text as is. */
	readonly infer: boolean;
	/** Ollama as the container sees it. */
	readonly ollamaUrl?: string;
	readonly log?: (line: string) => void;
}

interface Reply {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

/** Requests answered in order over a child's stdin and stdout, one JSON object per line. */
export class JsonLinesChannel {
	private readonly pending: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
	private closed: Error | undefined;
	private readonly child: Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "on">;

	constructor(child: Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "on">) {
		this.child = child;
		createInterface({ input: child.stdout }).on("line", (line) => {
			const waiter = this.pending.shift();
			if (!waiter) return;
			let reply: Reply;
			try {
				reply = JSON.parse(line) as Reply;
			} catch {
				waiter.reject(new Error(`unreadable reply: ${line.slice(0, 200)}`));
				return;
			}
			if (reply.ok) waiter.resolve(reply.result);
			else waiter.reject(new Error(reply.error ?? "request failed"));
		});
		child.on("exit", (code) => this.fail(new Error(`the driver exited (code ${code})`)));
		child.on("error", (e) => this.fail(e));
	}

	request(body: Readonly<Record<string, unknown>>): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			this.child.stdin.write(JSON.stringify(body) + "\n");
		});
	}

	private fail(e: Error): void {
		this.closed ??= e;
		for (const w of this.pending.splice(0)) w.reject(e);
	}
}

interface AddResult {
	readonly id: string;
	readonly memory: string | null;
	readonly event: string | null;
}

interface SearchResult {
	readonly id: string;
	readonly memory: string | null;
	readonly score: number | null;
}

export class Mem0Adapter implements ExternalAdapter {
	readonly name = "mem0";
	private readonly channel: JsonLinesChannel;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly container: string;
	private readonly info: SystemInfo;
	private readonly infer: boolean;

	private constructor(
		channel: JsonLinesChannel,
		child: ChildProcessWithoutNullStreams,
		container: string,
		info: SystemInfo,
		infer: boolean,
	) {
		this.channel = channel;
		this.child = child;
		this.container = container;
		this.info = info;
		this.infer = infer;
	}

	/** Build the image if needed, start a container and check it can reach Ollama. */
	static async start(options: Mem0Options): Promise<Mem0Adapter> {
		const log = options.log ?? (() => {});
		const image = ensureImage(join(import.meta.dirname, "mem0"), "memory-anywhere-eval/mem0", MEM0_VERSION, log);
		const container = containerName("mem0");
		const env = {
			OLLAMA_URL: options.ollamaUrl ?? "http://host.docker.internal:11434",
			MEM0_LLM_MODEL: MEM0_LLM,
			MEM0_EMBED_MODEL: MEM0_EMBEDDER,
			MEM0_EMBED_DIMS: String(MEM0_EMBED_DIMS),
		};
		const child = spawn("docker", runArgs(image.tag, container, env), { stdio: ["pipe", "pipe", "pipe"] });
		// mem0 logs to stderr; keep the last lines for a failure message.
		const tail: string[] = [];
		createInterface({ input: child.stderr }).on("line", (l) => {
			tail.push(l);
			if (tail.length > 20) tail.shift();
		});
		const channel = new JsonLinesChannel(child);
		try {
			const hello = (await channel.request({ op: "hello" })) as Record<string, unknown>;
			const info = { system: "mem0", image: image.tag, image_id: image.id, infer: options.infer, ...hello };
			return new Mem0Adapter(channel, child, container, info, options.infer);
		} catch (e) {
			removeContainer(container);
			throw new Error(`mem0 did not start: ${(e as Error).message}\n${tail.join("\n")}`, { cause: e });
		}
	}

	describe(): SystemInfo {
		return this.info;
	}

	capabilities(): Capabilities {
		return MEM0_CAPABILITIES;
	}

	async reset(): Promise<void> {
		await this.channel.request({ op: "reset" });
	}

	async save(fact: SaveFact, ctx: SaveCtx): Promise<Saved> {
		if (fact.supersedes) {
			await this.channel.request({ op: "update", id: fact.supersedes, text: fact.content });
			return { id: fact.supersedes, outcome: "updated" };
		}
		const results = (await this.channel.request({
			op: "add",
			text: fact.content,
			user_id: USER,
			infer: this.infer,
			metadata: { client: ctx.client, session: ctx.session, at: ctx.at },
		})) as AddResult[];
		const added = results.find((r) => r.event === "ADD");
		// With infer, one text can yield several memories; the first stands for the save.
		return added ? { id: added.id, outcome: "added" } : { outcome: "nothing stored" };
	}

	async recall(query: string, k: number, _ctx: RecallCtx): Promise<Recalled[]> {
		const results = (await this.channel.request({ op: "search", query, user_id: USER, top_k: k })) as SearchResult[];
		return results.map((r) => ({ id: r.id, content: r.memory ?? "", ...(r.score === null ? {} : { score: r.score }) }));
	}

	async forget(id: string): Promise<void> {
		await this.channel.request({ op: "delete", id });
	}

	async close(): Promise<void> {
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.stdin.end();
		const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000).unref());
		if ((await Promise.race([exited, timeout])) === "timeout") removeContainer(this.container);
	}
}
