// Suite C, local (evals.md §3.7): latency of the real server process with the real model.
//
//   1 start `memory-anywhere-server start --local --ephemeral` (its own temporary store and token)
//   2 enable a repo and save 300 memories through /v1/writes, as the spool would
//   3 200 warm `memory_recall` calls through /mcp, as the proxy makes them; p50 and p95
//   4 the characters a Claude Code session start injects
//
// Targets: warm local recall p95 ≤ 300 ms; ≤ 9,000 characters per Claude Code session.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SERVER_VERSION } from "../../packages/server/src/app.ts";
import { activeModel, modelDir } from "../../packages/server/src/embed/manifest.ts";

const CLI = path.join(import.meta.dirname, "..", "..", "packages", "server", "src", "cli.ts");
const REPO = "rk_c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const TOPICS = ["pnpm workspaces", "rust lifetimes", "postgres indexes", "kubernetes probes", "react suspense", "terraform state", "python typing", "go generics", "swift actors", "css grid"];
const QUERIES = ["how does the user manage monorepos", "database performance habits", "preferred deployment checks", "frontend data loading", "infrastructure tooling", "typing preferences in python", "concurrency in swift", "layout approach in css", "memory safety in rust", "generic code in go"];

export interface SuiteCResult {
  readonly suite: "C";
  readonly target: "local";
  readonly n: number;
  readonly recall_ms: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly recall_pass: boolean;
  readonly session_start_chars: number;
  readonly session_start_pass: boolean;
}

const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? NaN;
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function runSuiteC(modelFiles: string, calls = 200): Promise<SuiteCResult> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ma suite c "));
  const models = path.join(tmp, "models");
  mkdirSync(models);
  symlinkSync(modelFiles, modelDir(models, activeModel()), "junction");
  const port = await freePort();
  const toml = path.join(tmp, "server.toml");
  writeFileSync(toml, `[server]\nmode = "local"\nlisten = "127.0.0.1:${port}"\nmodels_dir = ${JSON.stringify(models)}\n`);
  const child = spawn(process.execPath, [CLI, "start", "--config", toml, "--ephemeral", "--no-rate-limits"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const tokenFile = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        const line = out.split("\n").find((l) => l.includes('"token_file"'));
        if (line) resolve((JSON.parse(line) as { token_file: string }).token_file);
      });
      child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, "content-type": "application/json", "ma-client-version": SERVER_VERSION, "ma-repo-key": REPO, "ma-tool": "claude-code" };
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);

    await post("/v1/admin/repo-enable", { repo_key: REPO, display_name: "suite c", capture: false });
    const now = Date.now();
    for (let batch = 0; batch < 3; batch++) {
      const entries = Array.from({ length: 100 }, (_, k) => {
        const n = batch * 100 + k;
        const topic = TOPICS[n % TOPICS.length] as string;
        return {
          idempotency_key: `spl_01JC9Z3N4V8Q2W5X7Y9Z${String(n).padStart(6, "0")}`, op: "save", observed_at: new Date(now).toISOString(), repo_key: REPO, session_id: `c${batch}`,
          payload: { content: `Prefers ${topic} approach number ${n} for team projects`, kind: "fact", why_durable: "working style", explicit_request: true, user_words: `remember i prefer ${topic} approach number ${n} for team projects` },
        };
      });
      await post("/v1/writes", { entries });
    }

    const start = await post("/v1/session-start", { tool: "claude-code", repo_key: REPO, session_id: "c-session", max_chars: 9000 });
    const client = new Client({ name: "suite-c", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    await client.callTool({ name: "memory_recall", arguments: { query: "warm up the model" } });
    const ms: number[] = [];
    for (let i = 0; i < calls; i++) {
      const t = performance.now();
      await client.callTool({ name: "memory_recall", arguments: { query: QUERIES[i % QUERIES.length] as string } });
      ms.push(performance.now() - t);
    }
    await client.close();
    const recall = { p50: Math.round(quantile(ms, 0.5)), p95: Math.round(quantile(ms, 0.95)), max: Math.round(Math.max(...ms)) };
    const chars = [...String(start["context"] ?? "")].length;
    return { suite: "C", target: "local", n: calls, recall_ms: recall, recall_pass: recall.p95 <= 300, session_start_chars: chars, session_start_pass: chars <= 9000 };
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}
