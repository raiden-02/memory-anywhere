#!/usr/bin/env node
// memory-anywhere-server, M0 stub edition. Implements only what the spike and
// the host scripts call:
//   start --config <server.toml> | --port <n>   HTTP (unix socket from the config, or a local port)
//   stdio                                        MCP over stdio (serveStdio)
//   setup-token --renew                          writes a fresh 30-minute token to the outbox
//   backup --out <file> | migrate                no-ops: the stub has no SQLite store
// Anything else exits 2, so a script that expects the real server fails loudly.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHttpServer } from "./http.ts";
import { createStubServer } from "./mcp.ts";
import { JsonlStore } from "./store.ts";

const HERE = import.meta.dirname;
/** The release's VERSION file: the nearest one above this file (the release root on the instance). */
const VERSION = (() => {
  for (let dir = HERE, i = 0; i < 6; i++, dir = dirname(dir)) {
    const p = join(dir, "VERSION");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  return "0.0.0-dev";
})();

/** What a spike built on the stub replaces (the OAuth spike: its HTTP app and real setup tokens). */
export interface ServerHooks {
  /** The HTTP server for `start`. Default: the stub's, with no authorization. */
  createServer?(o: { version: string; publicOrigin: string; dataDir: string }): Server;
  /** A fresh setup token the server will accept. Default: a random value nothing checks. */
  issueSetupToken?(o: { dataDir: string; ttlMs: number }): string;
}

/** The few keys the stub reads from server.toml (`key = "value"` lines only). */
export function readSimpleToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const s = /^\[([a-z_.]+)\]$/.exec(line);
    if (s?.[1]) {
      section = s[1];
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined) out[section ? `${section}.${kv[1]}` : kv[1]] = kv[2];
  }
  return out;
}

const OUTBOX = "/run/memory-anywhere/outbox";
const INSTANCE_CONFIG = "/etc/memory-anywhere/server.toml";
const SETUP_TOKEN_TTL_MS = 30 * 60_000;

function writeOutbox(name: string, content: string): void {
  // Write then rename, so the path unit never sees a half-written file. 0644 is
  // safe: the outbox directory itself is 2770 (deployment-aws.md §4).
  const tmp = join(OUTBOX, `.${name}.tmp`);
  writeFileSync(tmp, content, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(OUTBOX, name));
}

export async function main(argv: string[], hooks: ServerHooks = {}): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { config: { type: "string" }, port: { type: "string" }, renew: { type: "boolean", default: false }, out: { type: "string" } },
  });
  // Like the real server: --config, else the instance's server.toml when it exists
  // (operator commands run through SSM without --config, from an arbitrary directory).
  const configFile = values.config ?? (existsSync(INSTANCE_CONFIG) ? INSTANCE_CONFIG : undefined);
  const cfg = configFile ? readSimpleToml(readFileSync(configFile, "utf8")) : {};
  const dataDir = cfg["server.data_dir"] ?? process.env["MA_STUB_DATA"] ?? join(process.cwd(), ".stub-data");
  // Opened only by the commands that serve MCP; the others never touch the store.
  const openStore = () => new JsonlStore(join(dataDir, "stub-memories.jsonl"));

  switch (command) {
    case "start": {
      const publicOrigin = cfg["server.public_origin"] ?? `http://127.0.0.1:${values.port ?? "8787"}`;
      const server = hooks.createServer
        ? hooks.createServer({ version: VERSION, publicOrigin, dataDir })
        : createHttpServer({ version: VERSION, store: openStore(), publicOrigin });
      const socket = cfg["server.socket"];
      if (socket) {
        if (existsSync(socket)) unlinkSync(socket);
        await new Promise<void>((r) => server.listen(socket, r));
        chmodSync(socket, 0o660); // group ma-web (Caddy) may connect; the directory is set up by install.sh
      } else {
        await new Promise<void>((r) => server.listen(Number(values.port ?? "8787"), "127.0.0.1", r));
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", op: "start", version: VERSION, listen: socket ?? `127.0.0.1:${values.port ?? "8787"}` }));
      const stop = () => server.close(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return await new Promise<number>(() => {});
    }
    case "stdio":
      serveStdio(() => createStubServer({ version: VERSION, store: openStore(), client: "stdio" }));
      return await new Promise<number>(() => {});
    case "setup-token": {
      if (!values.renew) {
        console.error("usage: setup-token --renew");
        return 1;
      }
      const token = hooks.issueSetupToken?.({ dataDir, ttlMs: SETUP_TOKEN_TTL_MS }) ?? randomBytes(32).toString("base64url");
      const expires_at = new Date(Date.now() + SETUP_TOKEN_TTL_MS).toISOString();
      writeOutbox("setup-token", JSON.stringify({ token, expires_at }));
      console.log(`setup token issued, valid until ${expires_at}`);
      return 0;
    }
    case "backup":
    case "migrate":
      console.log(`${command}: the M0 stub has no SQLite store; nothing to do`);
      return 0;
    default:
      console.error(`memory-anywhere-server (M0 stub ${VERSION}): '${command ?? ""}' is not implemented in the stub`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
