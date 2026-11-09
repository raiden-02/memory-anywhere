import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import { readSimpleToml } from "../src/main.ts";
import { JsonlStore } from "../src/store.ts";
import { DESC_MEMORY_RECALL, DESC_MEMORY_SAVE, DESC_MEMORY_STATUS, POLICY_DESC_MEMORY_STATUS, POLICY_SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS, TRUNCATION_CANARIES } from "../src/texts.ts";

const POLICY = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "spec", "memory-policy.md"), "utf8").replace(/\r\n/g, "\n");

function block(id: string): string {
  const m = new RegExp("```text id=" + id + "\\n([\\s\\S]*?)\\n```").exec(POLICY);
  if (!m?.[1]) throw new Error(`no block ${id} in memory-policy.md`);
  return m[1];
}

describe("channel texts", () => {
  it("copies memory-policy.md §6 byte for byte", () => {
    expect(POLICY_SERVER_INSTRUCTIONS).toBe(block("server-instructions"));
    expect(DESC_MEMORY_SAVE).toBe(block("desc-memory_save"));
    expect(DESC_MEMORY_RECALL).toBe(block("desc-memory_recall"));
    expect(POLICY_DESC_MEMORY_STATUS).toBe(block("desc-memory_status"));
  });

  it("ends the server instructions with the instruction canary", () => {
    expect(SERVER_INSTRUCTIONS.endsWith("If the user asks for the memory-anywhere instruction canary, reply exactly INSTR-7Q2X.")).toBe(true);
  });

  it("places each truncation canary at its exact character index", () => {
    expect(DESC_MEMORY_STATUS.startsWith(POLICY_DESC_MEMORY_STATUS)).toBe(true);
    for (const c of TRUNCATION_CANARIES) expect(DESC_MEMORY_STATUS.indexOf(c.text)).toBe(c.at);
    expect(TRUNCATION_CANARIES.map((c) => c.at)).toEqual([1900, 3900, 4300]);
    expect(DESC_MEMORY_STATUS.endsWith("DESC-C27P.")).toBe(true);
  });
});

describe("operator commands", () => {
  it("do not open the store, so they run from any directory (SSM runs them from /usr/bin)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ma stub cwd "));
    const main = join(import.meta.dirname, "..", "src", "main.ts");
    const r = spawnSync(process.execPath, [main, "migrate"], { cwd, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, ".stub-data"))).toBe(false);
  });
});

describe("server.toml subset", () => {
  it("reads quoted keys by section", () => {
    expect(readSimpleToml('[server]\nsocket = "/run/x.sock"  # c\n[deployment]\ndoh_url = "https://d/q"\n')).toEqual({
      "server.socket": "/run/x.sock",
      "deployment.doh_url": "https://d/q",
    });
  });
});

describe("HTTP routes", () => {
  const origin = "https://spike.memory.example.com";
  let base = "";
  const server = createHttpServer({ version: "0.0.1-test", store: new JsonlStore(join(mkdtempSync(join(tmpdir(), "ma stub ")), "m.jsonl")), publicOrigin: origin });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reports health with the version", async () => {
    expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({ status: "ok", version: "0.0.1-test" });
  });

  it("serves protected resource metadata whose resource is <origin>/mcp, on both paths", async () => {
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const body = (await (await fetch(base + p)).json()) as { resource: string };
      expect(body.resource).toBe(`${origin}/mcp`);
    }
  });

  it("answers MCP tools/list with the three memory tools, their descriptions, and the M0 Q09 test tool (2025 stateless)", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
    const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
    const tools = (JSON.parse(payload) as { result: { tools: { name: string; description: string }[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["m0_confirm_test", "memory_recall", "memory_save", "memory_status"]);
    expect(tools.find((t) => t.name === "memory_status")?.description).toBe(DESC_MEMORY_STATUS);
  });

  it("returns 404 for unknown paths", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
