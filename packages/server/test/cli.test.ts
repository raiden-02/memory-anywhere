// `memory-anywhere-server` as a process (config-and-cli.md §4.4): `version`, and `start --ephemeral`
// with the real model, from a folder with a space in its path. The start test needs the model files
// (see embed.test.ts) and is skipped without them.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SERVER_VERSION } from "../src/app.ts";
import { activeModel, modelDir, verifyModel } from "../src/embed/manifest.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const tmp = mkdtempSync(path.join(os.tmpdir(), "ma cli "));
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

it("prints server, schema and policy versions", () => {
  const r = spawnSync(process.execPath, [CLI, "version"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ server: SERVER_VERSION, schema: SCHEMA_VERSION, policy: "P1" });
});

it("refuses to start in local mode on anything but 127.0.0.1", () => {
  const toml = path.join(tmp, "wide.toml");
  writeFileSync(toml, '[server]\nmode = "local"\nlisten = "0.0.0.0:47821"\n');
  const r = spawnSync(process.execPath, [CLI, "start", "--config", toml, "--ephemeral"], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/server\.listen: local mode listens on 127\.0\.0\.1:<port> only/u);
});

it("refuses an aws config without a socket or an https public URL", () => {
  const toml = path.join(tmp, "aws-tcp.toml");
  writeFileSync(toml, '[server]\nmode = "aws"\nlisten = "127.0.0.1:47821"\npublic_url = "http://memory.example.com"\ndata_dir = "/var/lib/memory-anywhere"\n');
  const r = spawnSync(process.execPath, [CLI, "start", "--config", toml], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/server\.listen: aws mode listens on a unix socket/u);
});

const SPIKE_DIR = path.join(import.meta.dirname, "..", "..", "..", "spikes", "embed-bench", "out", "models", "onnx-community__embeddinggemma-300m-ONNX@5090578d9565");
const REAL_DIR = process.env["MA_TEST_MODEL_DIR"] ?? SPIKE_DIR;
const haveModel = existsSync(REAL_DIR) && (await verifyModel(REAL_DIR, activeModel())).length === 0;

describe.runIf(haveModel)("start --ephemeral", () => {
  it("serves health and a recall with the real model, behind the local token", async () => {
    const models = path.join(tmp, "models dir");
    mkdirSync(models, { recursive: true });
    // A junction needs no admin rights on Windows, and points the server at the cached model files.
    symlinkSync(REAL_DIR, modelDir(models, activeModel()), "junction");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const toml = path.join(tmp, "server.toml");
    writeFileSync(toml, `[server]\nmode = "local"\nlisten = "127.0.0.1:${port}"\nmodels_dir = ${JSON.stringify(models)}\n`);

    const child = spawn(process.execPath, [CLI, "start", "--config", toml, "--ephemeral"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const started = await new Promise<{ listen: string; token_file: string }>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
          const line = out.split("\n").find((l) => l.includes('"token_file"'));
          if (line) resolve(JSON.parse(line) as { listen: string; token_file: string });
        });
        child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
      });
      expect(started.listen).toBe(`127.0.0.1:${port}`);
      const token = readFileSync(started.token_file, "utf8").trim();
      const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
      expect(health).toMatchObject({ ok: true, version: SERVER_VERSION });
      const recall = await fetch(`http://127.0.0.1:${port}/v1/recall`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "ma-client-version": SERVER_VERSION },
        body: JSON.stringify({ query: "where does the user live", repo_key: "none" }),
      });
      expect(recall.status).toBe(200);
    } finally {
      child.kill();
    }
  }, 60_000);
});
