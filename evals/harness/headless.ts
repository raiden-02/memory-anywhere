// What every model-driven eval shares (suites S, P and A): a fresh store served over MCP on a
// loopback port, a recording proxy in front of it that notes each tool the agent calls, and a
// headless Claude Code run against it.
//
//   claude -p (--restricted --strict-mcp-config) ──► recording proxy ──► store (in this process)
//
// Isolation: `--restricted --strict-mcp-config` ignores the user's settings, plugins, hooks and MCP
// servers (verified: no memory-anywhere hook of the owner's runs) and confines file tools to the
// working folder; the only MCP server is the eval store. No API key: Claude Code uses the owner's
// own sign-in (no eval keys, evals.md §1.7).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { newId } from "@memory-anywhere/contracts/ids";
import { App } from "../../packages/server/src/app.ts";
import { defaultConfig } from "../../packages/server/src/config/schema.ts";
import { Logger } from "../../packages/server/src/http/log.ts";
import { localHttpServer } from "../../packages/server/src/http/server.ts";
import { save } from "../../packages/server/src/write/pipeline.ts";
import { intakePrompt } from "../../packages/server/src/write/prompt.ts";
import { fakeEmbedder, localCaller, ownerCaller, REPO, saveReq, testStore, type TestStore } from "../../packages/server/test/helpers/store.ts";

export const SERVER_NAME = "memory-anywhere";
export const MEMORY_TOOLS = ["memory_recall", "memory_save", "memory_forget", "memory_status", "memory_profile"].map((t) => `mcp__${SERVER_NAME}__${t}`);
const TOKEN = "headless-eval-token-0123456789abcdefghijklmnopqrstu";

export interface ClaudeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs claude without blocking this process: the eval store answers from this same event loop,
 * so a synchronous spawn would leave the agent with a store that never replies.
 */
export function runClaude(args: readonly string[], o: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: string }): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    // claude is a native executable (claude.exe on Windows): no shell, so arguments with spaces stay whole.
    const child = spawn("claude", args, {
      cwd: o.cwd, stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true,
      // Headless runs otherwise start the turn before the MCP server has connected, so the agent has no memory tools.
      env: { ...process.env, MCP_CONNECTION_NONBLOCKING: "false", ...o.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    if (o.stdin !== undefined) child.stdin?.end(o.stdin);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export interface EvalStore {
  readonly app: App;
  readonly store: TestStore;
  /** Every tool the agent called, in order (from the recording proxy). */
  readonly calls: string[];
  /** Writes the MCP config that points claude at the proxy. */
  writeMcpConfig(file: string, session: string): void;
  /** Logs a user prompt as the plugin's UserPromptSubmit hook would (write-path.md §4 step 5). */
  userSaid(text: string, session: string): void;
  close(): Promise<void>;
}

/** A fresh store with the owner's `seed` memories, served on loopback behind a recording proxy. */
export async function startEvalStore(seed: readonly string[] = []): Promise<EvalStore> {
  const store = await testStore({ memory: true });
  const app = new App({ db: store.db, config: defaultConfig(), embedder: fakeEmbedder, clock: { now: Date.now }, ids: store.ids });
  for (const fact of seed) await save(app.write, ownerCaller(), saveReq(fact), { idempotencyKey: newId("adm"), observedAt: Date.now() });
  const port = await freePort();
  const server: Server = localHttpServer({ app, port, localToken: TOKEN, logger: new Logger(() => undefined) });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const calls: string[] = [];
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      try {
        const msg = JSON.parse(body.toString("utf8")) as { method?: string; params?: { name?: string } };
        if (msg.method === "tools/call" && msg.params?.name) calls.push(msg.params.name);
      } catch {
        // not JSON (or a batch): forwarded as is
      }
      const upstream = httpRequest({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => res.destroy());
      upstream.end(body);
    });
  });
  const proxyPort = await freePort();
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));

  return {
    app, store, calls,
    writeMcpConfig(file, session) {
      writeFileSync(file, JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: "http", url: `http://127.0.0.1:${proxyPort}/mcp`,
            headers: { authorization: `Bearer ${TOKEN}`, "ma-client-version": "0.1.0", "ma-tool": "claude-code", "ma-repo-key": REPO, "ma-session": session },
          },
        },
      }));
    },
    userSaid(text, session) {
      intakePrompt(app.write, localCaller(), newId("spl"), text, session, Date.now());
    },
    async close() {
      proxy.closeAllConnections();
      server.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

/** Current versions of active or contested memories, and open observations, as stored text. */
export function storedTexts(s: EvalStore): { active: string[]; observations: string[] } {
  const active = (s.store.db.prepare(
    `SELECT v.content FROM memory m JOIN memory_version v ON v.memory_id = m.id AND v.valid_to IS NULL AND v.expired_at IS NULL
     WHERE m.status IN ('active','contested') AND v.content IS NOT NULL`,
  ).all() as { content: string }[]).map((r) => r.content);
  const observations = (s.store.db.prepare("SELECT content FROM observation WHERE status = 'open' AND content IS NOT NULL").all() as { content: string }[]).map((r) => r.content);
  return { active, observations };
}
