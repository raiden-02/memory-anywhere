// `mema mcp --tool <t>` (topology-and-ipc.md §5): a stdio MCP server that relays every call to the
// store's /mcp with the PC's credential and the MA-* headers. When the store cannot be reached, it
// answers from the PC: saves are spooled, recall and profile come from the caches, status says
// offline. The same five tools are listed either way.
//
//   coding tool ──stdio──► proxy ──HTTP /mcp──► store
//                            │ offline
//                            ├─ memory_save   → spool (pxs_ key kept), outcome "queued"
//                            ├─ memory_recall → cached repo context / profile
//                            └─ memory_status → health "offline", spool count

import { createHash } from "node:crypto";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { idSource } from "@memory-anywhere/contracts/ids";
import { hasSecret } from "@memory-anywhere/contracts/redact";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { toJsonSchema } from "@memory-anywhere/contracts/json-schema";
import { CLIENT_TEXTS, POLICY_VERSION } from "@memory-anywhere/contracts/policy-data";
import { ERROR_META_KEY, IDEMPOTENCY_META_KEY, TOOLS, TOOL_ORDER, type ToolName } from "@memory-anywhere/contracts/schemas/tools";
import { CLIENT_VERSION, type ClientConfigT } from "./config.ts";
import { offlineHeader, readCursorActive, readProfile, readRepoContext, readTools, writeTools } from "./cache.ts";
import { logLine } from "./log.ts";
import { NONE, proxyRepoDir, repoIdentity } from "./repo-key.ts";
import { drain, spoolStats, spoolWrite } from "./spool.ts";
import type { StoreClient } from "./store-client.ts";

export type ProxyTool = "claude-code" | "codex" | "cursor" | "generic";

const LIST_TTL_MS = 3_600_000;
const SAVE_DRAIN_MS = 500;
const DRAIN_EVERY_MS = 60_000;
const CURSOR_ACTIVE_MAX_AGE_MS = 12 * 3_600_000;

/**
 * The tool this proxy really serves. Cursor imports Claude Code plugins and starts their MCP
 * servers itself, so a proxy started with `--tool claude-code` may be serving Cursor, which gives
 * it no project folder. Claude Code sets `CLAUDECODE=1` for every MCP server it starts; Cursor sets
 * `WORKSPACE_FOLDER_PATHS` (only the first window's folder) and `VSCODE_CWD` in its install folder
 * (spec-issues #51).
 */
export function hostTool(requested: ProxyTool, env: NodeJS.ProcessEnv): ProxyTool {
  if (requested !== "claude-code" || env["CLAUDECODE"] === "1") return requested;
  const cursor = env["WORKSPACE_FOLDER_PATHS"] !== undefined || /cursor/iu.test(env["VSCODE_CWD"] ?? "");
  return cursor ? "cursor" : requested;
}

/** The five tools as compiled into the client, for when the store and the cache are both missing. */
export function builtInTools(): Tool[] {
  return TOOL_ORDER.map((name) => ({
    name,
    title: TOOLS[name].annotations.title,
    description: CLIENT_TEXTS[`desc-${name}`],
    inputSchema: toJsonSchema(TOOLS[name].input, "input") as Tool["inputSchema"],
    outputSchema: toJsonSchema(TOOLS[name].output, "output") as Tool["outputSchema"],
    annotations: { ...TOOLS[name].annotations },
    _meta: { "anthropic/alwaysLoad": true },
  }));
}

/** An error result: text plus the Error object in _meta, never structuredContent (spec-issues #50). */
const errorResult = (code: string, message: string): CallToolResult => ({
  content: [{ type: "text", text: `${code}: ${message}` }],
  _meta: { [ERROR_META_KEY]: { code, message } },
  isError: true,
});

export interface ProxyDeps {
  readonly paths: Paths;
  readonly config: ClientConfigT;
  readonly store: StoreClient;
  readonly tool: ProxyTool;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly now: () => number;
}

/** Why a relay failed: the store is out of reach, or it answered with a status the proxy maps. */
type Failure = { kind: "offline" } | { kind: "too_old" } | { kind: "unauthorized" };

function classify(e: unknown): Failure {
  // A StoreError thrown by the store client's fetch (no PC grant) may arrive wrapped by the transport.
  const status = (e as { status?: number }).status ?? (e as { cause?: { status?: number } }).cause?.status;
  if (status === 426) return { kind: "too_old" };
  if (status === 401) return { kind: "unauthorized" };
  return { kind: "offline" };
}

export class Proxy {
  readonly #deps: ProxyDeps;
  /** The repo the current connection was opened for (its MA-Repo-Key header). */
  #repoKey: string;
  readonly #fixedRepoKey: string;
  readonly #session: string;
  #remote: Client | undefined;
  #logged = false;
  lastContact: number | undefined;

  constructor(deps: ProxyDeps) {
    this.#deps = deps;
    this.#fixedRepoKey = repoIdentity(proxyRepoDir(deps.env, deps.cwd), deps.config.repos.deny_remotes).repoKey;
    this.#repoKey = this.#fixedRepoKey;
    this.#session = idSource().newId("pxy", deps.now());
  }

  get repoKey(): string {
    return this.#currentRepo();
  }

  /**
   * The repo of this call. Cursor shares one MCP process across windows, so its repo comes from
   * the latest Cursor hook (within 12 hours), else the folder the proxy started in. A change of
   * repo opens a new connection, because the repo key travels in a header.
   */
  #currentRepo(): string {
    const { tool, paths, now } = this.#deps;
    const active = tool === "cursor" ? readCursorActive(paths, now(), CURSOR_ACTIVE_MAX_AGE_MS) : undefined;
    const repo = active ?? this.#fixedRepoKey;
    if (repo !== this.#repoKey || !this.#logged) {
      // One line per decision, so `mema doctor` and the owner can see which repo the proxy acts for.
      logLine(path.join(paths.logsDir, "client.log"), { op: "proxy.repo", tool, repo_key: repo, source: active ? "cursor-hook" : "start-folder", fixed_repo_key: this.#fixedRepoKey });
      this.#logged = true;
    }
    if (repo !== this.#repoKey) {
      this.#dropClient();
      this.#repoKey = repo;
    }
    return repo;
  }

  async #client(): Promise<Client> {
    this.#currentRepo();
    if (this.#remote) return this.#remote;
    const { store, tool } = this.#deps;
    if (!store.url) throw Object.assign(new Error("no store configured"), { status: 0 });
    const client = new Client({ name: "memory-anywhere-proxy", version: CLIENT_VERSION });
    const headers = store.headers({ tool, repoKey: this.#repoKey, session: this.#session });
    // The store client's fetch adds the bearer (refreshing the PC grant when needed).
    await client.connect(new StreamableHTTPClientTransport(new URL(`${store.url}/mcp`), { requestInit: { headers }, fetch: store.fetch }), { timeout: this.#deps.config.network.call_timeout_ms });
    this.#remote = client;
    return client;
  }

  #dropClient(): void {
    void this.#remote?.close().catch(() => undefined);
    this.#remote = undefined;
  }

  async listTools(): Promise<Tool[]> {
    const { paths, now } = this.#deps;
    const cached = readTools(paths);
    if (cached && Date.parse(cached.fetched_at) + cached.ttl_ms > now()) return cached.tools as Tool[];
    try {
      const r = await (await this.#client()).listTools(undefined, { timeout: this.#deps.config.network.call_timeout_ms });
      this.lastContact = now();
      const ttlMs = (r as Record<string, unknown>)["ttlMs"];
      const ttl = typeof ttlMs === "number" ? ttlMs : LIST_TTL_MS;
      writeTools(paths, { tools: r.tools, fetched_at: new Date(now()).toISOString(), ttl_ms: ttl });
      return r.tools;
    } catch {
      this.#dropClient();
      return (cached?.tools as Tool[] | undefined) ?? builtInTools();
    }
  }

  async callTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const { config, paths, store, now } = this.#deps;
    const isSave = name === "memory_save";
    const key = isSave ? idSource().newId("pxs", now()) : undefined;
    // A spooled prompt should reach the store before the save that may quote it (§5 step 4).
    if (isSave) await drain(paths, store, now() + SAVE_DRAIN_MS, now).catch(() => undefined);
    try {
      const result = await (await this.#client()).callTool(
        { name, arguments: args, _meta: { ...(meta ?? {}), ...(key ? { [IDEMPOTENCY_META_KEY]: key } : {}) } },
        { timeout: isSave ? config.network.save_timeout_ms : config.network.call_timeout_ms },
      );
      this.lastContact = now();
      return result as CallToolResult;
    } catch (e) {
      this.#dropClient();
      const failure = classify(e);
      if (failure.kind === "too_old") return errorResult("CLIENT_TOO_OLD", `Upgrade with: npm i -g memory-anywhere@latest`);
      if (failure.kind === "unauthorized") return errorResult("UNAUTHORIZED", "Run `mema login`.");
      return this.offline(name as ToolName, args, key);
    }
  }

  /** The offline answers of topology-and-ipc.md §5 step 6. */
  offline(name: ToolName, args: Record<string, unknown>, key: string | undefined): CallToolResult {
    const { paths, now, tool } = this.#deps;
    switch (name) {
      case "memory_save": {
        if (args["supersedes"] !== undefined) return errorResult("STORE_UNAVAILABLE", "Corrections need the store; try again later.");
        const texts = ["content", "user_words", "why_durable"].map((f) => args[f]).filter((v): v is string => typeof v === "string");
        // The spool holds only redacted text, and the store would refuse a secret anyway (row D1).
        if (texts.some(hasSecret)) {
          const out = { outcome: "rejected", reason: "secret", message: "looks like a password, key or token; not saved", policy_version: POLICY_VERSION };
          return { content: [{ type: "text", text: `rejected: ${out.message}` }], structuredContent: out, isError: false };
        }
        const payload = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "supersedes" && k !== "change"));
        spoolWrite(paths, {
          idempotency_key: key ?? idSource().newId("pxs", now()), spooled_at: new Date(now()).toISOString(), op: "save",
          tool: tool === "generic" ? "claude-code" : tool, repo_key: this.#repoKey, session_id: this.#session, payload: payload as never,
        });
        const out = { outcome: "queued", reason: "offline", message: "kept on this PC; it is saved when the store is reachable", idempotency_key: key, policy_version: POLICY_VERSION };
        return { content: [{ type: "text", text: `queued: ${out.message}` }], structuredContent: out, isError: false };
      }
      case "memory_recall": {
        const cached = (this.#repoKey !== NONE ? readRepoContext(paths, this.#repoKey) : undefined) ?? readProfile(paths);
        const notice = offlineHeader(cached?.generatedAt ?? "never");
        const out = { notice, items: [], truncated: false, budget_exhausted: false, offline: true };
        return { content: [{ type: "text", text: cached ? `${notice}\n${cached.text}` : notice }], structuredContent: out, isError: false };
      }
      case "memory_profile": {
        const cached = readProfile(paths);
        const notice = offlineHeader(cached?.generatedAt ?? "never");
        const text = cached?.text ?? "";
        const out = {
          notice, policy_version: POLICY_VERSION, profile_etag: createHash("sha256").update(text, "utf8").digest("hex"), text,
          sections: [], owner_preferences: [], pinned: [], key_facts: [], pending_review_count: 0, offline: true,
        };
        return { content: [{ type: "text", text: `${notice}\n${text}` }], structuredContent: out, isError: false };
      }
      case "memory_forget":
        return errorResult("STORE_UNAVAILABLE", "Forgetting needs the store; try again later.");
      case "memory_status": {
        const out = {
          store: "offline", health: "offline", client: { name: "memory-anywhere on this PC", class: "coding", read: true, write: true },
          policy_version_server: "unknown", policy_version_reported: POLICY_VERSION, server_version: "unknown",
          ...(this.lastContact ? { last_contact_at: new Date(this.lastContact).toISOString() } : {}),
          spool_count: spoolStats(paths).count,
        };
        return { content: [{ type: "text", text: `offline; ${out.spool_count} writes waiting on this PC` }], structuredContent: out, isError: false };
      }
    }
  }

  /** The stdio server for one coding-tool connection. */
  server(): Server {
    const server = new Server({ name: "memory-anywhere", version: CLIENT_VERSION }, { capabilities: { tools: {} }, instructions: CLIENT_TEXTS["server-instructions"] });
    server.setRequestHandler("tools/list", async () => ({ tools: await this.listTools() }));
    server.setRequestHandler("tools/call", async (request) => this.callTool(request.params.name, request.params.arguments ?? {}, request.params._meta));
    return server;
  }
}

/** Runs the proxy on stdio until the coding tool closes it; drains the spool every minute meanwhile. */
export function runProxy(deps: ProxyDeps): void {
  const proxy = new Proxy(deps);
  serveStdio(() => proxy.server());
  setInterval(() => void drain(deps.paths, deps.store, deps.now() + 5000, deps.now).catch(() => undefined), DRAIN_EVERY_MS).unref();
}
