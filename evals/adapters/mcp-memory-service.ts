// mcp-memory-service as a baseline (evals.md §7, §8.1): version 12.7.0 in a local Docker container,
// SQLite-vec backend, local ONNX embeddings (all-MiniLM-L6-v2), driven only through its MCP tools
// over stdio, as a chat client would drive it.
//
//   adapter ──MCP (stdio)──► docker run mcp-memory-service ──► SQLite-vec + ONNX, in the container
//
//   reset   memory_delete {tags: [TAG]}           every save carries TAG, so this empties the store
//   save    memory_store {content, conversation_id, restore_deleted, metadata: {tags: TAG}}
//           memory_update {content_hash, versioned: true}   when the fact supersedes a memory
//   recall  memory_search {query, limit}          the tool's default mode, semantic
//   forget  memory_delete {content_hash}
//
// Ids are the service's content hashes, sha256 of the trimmed, lower-cased content. Two choices
// follow the tool descriptions: every save passes its session as conversation_id, the documented
// way to save the turns of a conversation (it skips the service's semantic dedup, not its exact-hash
// dedup); and restore_deleted, so content that a reset deleted can be saved again by a later case.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

export const MCP_MEMORY_SERVICE_VERSION = "12.7.0";
export const MCP_MEMORY_SERVICE_EMBEDDER = "all-MiniLM-L6-v2 (ONNX, CPU)";
/**
 * memory_update {versioned: true} writes a new version and marks the old one superseded. Its
 * as_of looks at record time only, so there is no valid time; saves report stored or duplicate,
 * not a policy outcome.
 */
export const MCP_MEMORY_SERVICE_CAPABILITIES: Capabilities = { supersede: true, bitemporal: false, outcomes: false };
/** Carried by every memory the adapter saves; reset deletes by it. */
const TAG = "ma-eval";

interface ToolResult {
	readonly content?: readonly { type: string; text?: string }[];
	readonly isError?: boolean;
}

function textOf(r: ToolResult): string {
	return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** The service's memory id for a content (utils/hashing.py: sha256 of strip().lower()). */
export function contentHash(content: string): string {
	return createHash("sha256").update(content.trim().toLowerCase(), "utf8").digest("hex");
}

/** memory_store's reply: the new hash, or the duplicate it met. */
export function parseStore(r: ToolResult, content: string): Saved {
	const text = textOf(r);
	const stored = /Memory stored successfully \(hash: ([0-9a-f]{64})\)/u.exec(text);
	if (!r.isError && stored?.[1]) return { id: stored[1], outcome: "stored" };
	if (/Duplicate content detected \(exact match\)/u.test(text))
		return { id: contentHash(content), outcome: "duplicate" };
	if (/Duplicate content detected \(semantically similar to ([0-9a-f]+)\)/u.test(text))
		return { outcome: "semantic duplicate" };
	throw new Error(`memory_store failed: ${text.slice(0, 300)}`);
}

/**
 * memory_search's reply, a numbered list in rank order (handlers/memory.py, _format_search_memory):
 *
 *   1. <content, possibly several lines>
 *      Hash: <64 hex>
 *      Created: <iso> [tags]
 *
 * The service reports no score in this format.
 */
export function parseSearch(text: string): Recalled[] {
	const out: Recalled[] = [];
	const entry = /(?:^|\n\n)(\d+)\. ([\s\S]*?)\n {3}Hash: ([0-9a-f]{64})\n {3}Created: /gu;
	for (const m of text.matchAll(entry)) out.push({ id: m[3] as string, content: m[2] as string });
	return out;
}

export class McpMemoryServiceAdapter implements ExternalAdapter {
	readonly name = "mcp-memory-service";
	private readonly client: Client;
	private readonly container: string;
	private readonly info: SystemInfo;

	private constructor(client: Client, container: string, info: SystemInfo) {
		this.client = client;
		this.container = container;
		this.info = info;
	}

	/** Build the image if needed and connect to a fresh container over stdio. */
	static async start(options: { log?: (line: string) => void } = {}): Promise<McpMemoryServiceAdapter> {
		const image = ensureImage(
			join(import.meta.dirname, "mcp-memory-service"),
			"memory-anywhere-eval/mcp-memory-service",
			MCP_MEMORY_SERVICE_VERSION,
			options.log,
		);
		const container = containerName("mcp-memory-service");
		const [command, ...args] = ["docker", ...runArgs(image.tag, container, {})];
		const client = new Client({ name: "memory-anywhere-evals", version: "1.0.0" });
		try {
			await client.connect(new StdioClientTransport({ command: command as string, args, stderr: "ignore" }));
		} catch (e) {
			removeContainer(container);
			throw new Error(`mcp-memory-service did not start: ${(e as Error).message}`, { cause: e });
		}
		const server = client.getServerVersion();
		if (server?.version !== MCP_MEMORY_SERVICE_VERSION) {
			await client.close();
			removeContainer(container);
			throw new Error(
				`expected mcp-memory-service ${MCP_MEMORY_SERVICE_VERSION}, the container runs ${server?.version ?? "unknown"}`,
			);
		}
		const info = {
			system: "mcp-memory-service",
			version: server.version,
			image: image.tag,
			image_id: image.id,
			backend: "sqlite_vec",
			embedder: MCP_MEMORY_SERVICE_EMBEDDER,
			search_mode: "semantic",
		};
		return new McpMemoryServiceAdapter(client, container, info);
	}

	describe(): SystemInfo {
		return this.info;
	}

	capabilities(): Capabilities {
		return MCP_MEMORY_SERVICE_CAPABILITIES;
	}

	private async call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
		return (await this.client.callTool({ name, arguments: { ...args } })) as ToolResult;
	}

	async reset(): Promise<void> {
		const r = await this.call("memory_delete", { tags: [TAG] });
		if (r.isError) throw new Error(`reset failed: ${textOf(r).slice(0, 300)}`);
	}

	async save(fact: SaveFact, ctx: SaveCtx): Promise<Saved> {
		if (fact.supersedes) {
			const r = await this.call("memory_update", {
				content_hash: fact.supersedes,
				versioned: true,
				updates: { content: fact.content, tags: [TAG] },
			});
			const hash = /New hash: ([0-9a-f]{64})/u.exec(textOf(r))?.[1];
			if (r.isError || !hash) throw new Error(`memory_update failed: ${textOf(r).slice(0, 300)}`);
			return { id: hash, outcome: "updated" };
		}
		const r = await this.call("memory_store", {
			content: fact.content,
			conversation_id: ctx.session,
			restore_deleted: true,
			metadata: { tags: [TAG], type: "note" },
		});
		return parseStore(r, fact.content);
	}

	async recall(query: string, k: number, _ctx: RecallCtx): Promise<Recalled[]> {
		const r = await this.call("memory_search", { query, limit: k });
		if (r.isError) throw new Error(`memory_search failed: ${textOf(r).slice(0, 300)}`);
		return parseSearch(textOf(r)).slice(0, k);
	}

	async forget(id: string): Promise<void> {
		const r = await this.call("memory_delete", { content_hash: id });
		if (r.isError) throw new Error(`memory_delete failed: ${textOf(r).slice(0, 300)}`);
	}

	async close(): Promise<void> {
		await this.client.close();
		removeContainer(this.container);
	}
}
