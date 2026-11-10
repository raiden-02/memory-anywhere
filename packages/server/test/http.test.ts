// The local-mode server over real HTTP (topology-and-ipc.md §4; mcp-interface.md §1, §4, §7;
// operations.md §1): the gates every request passes, the five tools through the MCP SDK client,
// the /v1 routes, the owner commands, the route inventory, and the log canary.

import { createServer as createNetServer, type AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { newId } from "@memory-anywhere/contracts/ids";
import { afterEach, describe, expect, it } from "vitest";
import { App, SERVER_VERSION } from "../src/app.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { Logger } from "../src/http/log.ts";
import { createHttpServer, ROUTES } from "../src/http/server.ts";
import { fakeEmbedder, REPO, testStore, type TestStore } from "./helpers/store.ts";

const TOKEN = "test-local-token-0123456789abcdefghijklmnopqrstuv";

interface Running {
  s: TestStore;
  app: App;
  base: string;
  port: number;
  logs: string[];
  server: Server;
}

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await new Promise((resolve) => r.server.close(resolve));
    r.s.close();
  }
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function boot(): Promise<Running> {
  const s = await testStore({ memory: true });
  const app = new App({ db: s.db, config: defaultConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
  const port = await freePort();
  const logs: string[] = [];
  const server = createHttpServer({ app, port, localToken: TOKEN, logger: new Logger((l) => logs.push(l)) });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const r = { s, app, base: `http://127.0.0.1:${port}`, port, logs, server };
  running.push(r);
  return r;
}

const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "ma-client-version": SERVER_VERSION, "ma-repo-key": REPO, "ma-tool": "claude-code", ...extra,
});

async function call(r: Running, method: string, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${r.base}${route}`, { method, headers: headers(extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function mcpClient(r: Running, extra: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`), { requestInit: { headers: headers({ "ma-session": "pxy_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", ...extra }) } }));
  return client;
}

describe("gates", () => {
  it("answers health without a token", async () => {
    const r = await boot();
    const res = await fetch(`${r.base}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: SERVER_VERSION, schema_version: 1, policy_version: "P1" });
  });

  it("rejects a foreign Host or Origin, a missing token, and an unsupported client", async () => {
    const r = await boot();
    // fetch() always sends the real Host, so a DNS-rebinding request is made with node:http.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port: r.port, path: "/v1/status", headers: { ...headers(), host: `evil.example.com:${r.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });
    expect(hostStatus).toBe(403);
    expect((await call(r, "GET", "/v1/status", undefined, { origin: "https://evil.example.com" })).status).toBe(403);
    const anon = await fetch(`${r.base}/v1/status`, { headers: { "ma-client-version": SERVER_VERSION } });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/^Bearer /u);
    expect((await call(r, "GET", "/v1/status", undefined, { "ma-client-version": "9.0.0" })).status).toBe(426);
    expect((await call(r, "GET", "/v1/nope")).status).toBe(404);
  });

  it("refuses bodies over 1 MiB on /v1", async () => {
    const r = await boot();
    const res = await call(r, "POST", "/v1/recall", { query: "x".repeat(1_100_000), repo_key: REPO });
    expect(res.status).toBe(413);
  });
});

describe("MCP", () => {
  it("lists the five tools in order with their policy descriptions", async () => {
    const r = await boot();
    const client = await mcpClient(r);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["memory_recall", "memory_profile", "memory_save", "memory_forget", "memory_status"]);
    expect(tools[0]?.description).toMatch(/policy P1$/u);
    expect(JSON.stringify(tools)).not.toContain('"$schema"');
    await client.close();
  });

  it("saves through the proxy key, recalls it, and reports invalid input with the field", async () => {
    const r = await boot();
    r.s.db.prepare("INSERT INTO session_prompt (id, client_id, repo_key, tool_session, prompt, received_at, expires_at) VALUES (?, 'cli_local', ?, 's', ?, ?, ?)")
      .run(newId("spr"), REPO, "remember: I deploy every service with pnpm workspaces", new Date(r.s.clock.now()).toISOString(), "2099-01-01T00:00:00.000Z");
    const client = await mcpClient(r);
    const saved = await client.callTool({
      name: "memory_save",
      arguments: { content: "Deploys every service with pnpm workspaces", kind: "fact", why_durable: "a lasting habit", user_words: "I deploy every service with pnpm workspaces" },
      _meta: { "memory-anywhere/idempotency_key": "pxs_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" },
    });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({ outcome: "active", idempotency_key: "pxs_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" });
    const recalled = await client.callTool({ name: "memory_recall", arguments: { query: "pnpm workspaces deploy" } });
    expect((recalled.content as { text: string }[])[0]?.text).toContain("Deploys every service with pnpm workspaces");
    const bad = await client.callTool({ name: "memory_recall", arguments: { query: "" } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: "INVALID_INPUT", field: "query" });
    const status = await client.callTool({ name: "memory_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ store: "local", health: "ok", client: { class: "coding", repo_enabled: true } });
    await client.close();
  });

  it("omits the write tools for a read-only client", async () => {
    const r = await boot();
    r.s.db.prepare("UPDATE client_policy SET write = 0 WHERE client_id = 'cli_local'").run();
    const client = await mcpClient(r);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["memory_recall", "memory_profile", "memory_status"]);
    await client.close();
  });
});

describe("/v1", () => {
  it("takes prompts and saves from the spool, and refuses a spooled forget", async () => {
    const r = await boot();
    const t = new Date(r.s.clock.now()).toISOString();
    const res = await call(r, "POST", "/v1/writes", {
      entries: [
        { idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2A", op: "prompt", observed_at: t, repo_key: REPO, tool: "claude-code", session_id: "s1", payload: { prompt: "remember that I use uv for python" } },
        { idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2B", op: "save", observed_at: t, repo_key: REPO, session_id: "s1", payload: { content: "Uses uv for python projects", kind: "fact", why_durable: "tooling", user_words: "I use uv for python" } },
        { idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2D", op: "forget", observed_at: "2020-01-01T00:00:00.000Z", payload: { id: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", reason: "old" } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body["results"]).toEqual([
      { idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2A", outcome: "active", reason: "prompt_stored" },
      expect.objectContaining({ idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2B", outcome: "active" }),
      { idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2D", outcome: "rejected", reason: "forget_not_spooled" },
    ]);
  });

  it("serves session-start, a projection with an etag, and repo checks", async () => {
    const r = await boot();
    const start = await call(r, "POST", "/v1/session-start", { tool: "claude-code", repo_key: REPO, session_id: "s1", max_chars: 9000 });
    expect(start.body).toMatchObject({ repo_enabled: true, policy_version: "P1" });
    expect(String(start.body["context"])).toContain("memory-anywhere is active for this repository");
    const p = await call(r, "GET", `/v1/projection?repo_key=${REPO}`);
    expect(p.status).toBe(200);
    const again = await fetch(`${r.base}/v1/projection?repo_key=${REPO}&etag=${String(p.body["etag"])}`, { headers: headers() });
    expect(again.status).toBe(304);
    expect((await call(r, "POST", "/v1/repos/check", { repo_key: REPO })).body).toEqual({ enabled: true, capture: false, project: null });
  });

  it("runs the owner's commands with the local token", async () => {
    const r = await boot();
    const key = "rk_11111111111111111111111111111111";
    const en = await call(r, "POST", "/v1/admin/repo-enable", { repo_key: key, display_name: "notes app", capture: false, track: { name: "notes app", repo_url: null } });
    expect(en.status).toBe(200);
    expect(en.body["project_entity_id"]).toMatch(/^ent_/u);
    expect((await call(r, "POST", "/v1/repos/check", { repo_key: key })).body).toEqual({ enabled: true, capture: false, project: "notes app" });
    const ctx = await call(r, "POST", "/v1/session-start", { tool: "cursor", repo_key: key, session_id: "s2", max_chars: 6000 });
    expect(String(ctx.body["context"])).toContain("## Project");
    expect((await call(r, "POST", "/v1/admin/review", { approve: [], reject: [] })).body).toMatchObject({ resolved: 0 });
    expect((await call(r, "POST", "/v1/admin/repo-disable", { repo_key: key })).body).toEqual({ repo_key: key, enabled: false });
    expect((await call(r, "POST", "/v1/admin/export", {})).status).toBe(404);
  });
});

describe("inventory and logs", () => {
  it("serves exactly the local-mode routes of mcp-interface.md §7", () => {
    expect([...ROUTES].sort()).toEqual([
      "GET /v1/health", "GET /v1/projection", "GET /v1/status", "POST /mcp", "POST /v1/admin/project-add", "POST /v1/admin/project-track",
      "POST /v1/admin/repo-disable", "POST /v1/admin/repo-enable", "POST /v1/admin/review", "POST /v1/recall", "POST /v1/repos/check",
      "POST /v1/session-start", "POST /v1/writes",
    ]);
  });

  it("never writes content, queries, prompts or tokens to the log", async () => {
    const r = await boot();
    const canary = "zebracanary";
    const t = new Date(r.s.clock.now()).toISOString();
    await call(r, "POST", "/v1/writes", { entries: [{ idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2A", op: "prompt", observed_at: t, repo_key: REPO, payload: { prompt: `remember ${canary} prompt` } }] });
    await call(r, "POST", "/v1/recall", { query: `${canary} recall query`, repo_key: REPO });
    const client = await mcpClient(r);
    await client.callTool({ name: "memory_save", arguments: { content: `Keeps a ${canary} plant`, kind: "fact", why_durable: canary, user_words: canary } });
    await client.callTool({ name: "memory_recall", arguments: { query: `${canary} plant` } });
    await client.close();
    await fetch(`${r.base}/v1/status`, { headers: { authorization: `Bearer ${canary}-token` } });
    expect(r.logs.length).toBeGreaterThan(5);
    for (const line of r.logs) {
      expect(line).not.toContain(canary);
      expect(line).not.toContain(TOKEN);
    }
  });
});
