#!/usr/bin/env node
// `memory-anywhere-server` (config-and-cli.md §4.4): start, init, migrate, dump, backup, version.
//
// Local mode keeps everything under the user's data folder: the store in `{data}\server`, the
// model files in `{data}\models`, and the owner credential in `{data}\local.token`, readable only
// by the user. `server.toml` can point elsewhere; `--ephemeral` uses a temporary folder that is
// deleted at exit (tests and suite C).

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { idSource } from "@memory-anywhere/contracts/ids";
import { currentPaths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir, writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import { App, SCHEMA_VERSION, SERVER_VERSION } from "./app.ts";
import { defaultConfig, parseConfig, type ServerConfigT } from "./config/schema.ts";
import { activeModel, downloadModel, modelDir, type PinnedModel } from "./embed/manifest.ts";
import { OnnxEmbedder } from "./embed/onnx.ts";
import { Logger } from "./http/log.ts";
import { createHttpServer } from "./http/server.ts";
import { JobWorker } from "./jobs/worker.ts";
import { POLICY_VERSION } from "./policy/generated.ts";
import { systemClock } from "./store/clock.ts";
import { openStore } from "./store/db.ts";
import { canonicalDump, contentDump } from "./store/dump.ts";
import { initStore } from "./store/init.ts";
import { migrate, schemaVersion } from "./store/migrate.ts";

const GEMMA_TERMS = "https://ai.google.dev/gemma/terms";

export interface Layout {
  readonly config: ServerConfigT;
  readonly dataDir: string;
  readonly storeFile: string;
  readonly tokenFile: string;
  readonly modelsDir: string;
}

/** Where this server keeps its files: server.toml values, else the platform defaults. */
export function layout(configFile: string | undefined, dataOverride?: string): Layout {
  const paths = currentPaths();
  const file = configFile ?? paths.localServerConfigFile;
  const config = existsSync(file) ? parseConfig(readFileSync(file, "utf8"), file) : defaultConfig();
  const dataDir = dataOverride ?? (config.server.data_dir || paths.localServerDataDir);
  return {
    config,
    dataDir,
    storeFile: path.join(dataDir, "store.db"),
    tokenFile: dataOverride ? path.join(dataOverride, "local.token") : config.server.local_token_file || paths.localTokenFile,
    modelsDir: config.server.models_dir || paths.modelsDir,
  };
}

const embeddingMeta = (m: PinnedModel) => ({
  modelId: m.modelId, dim: m.dims, queryPrefix: m.query_prefix, docPrefix: m.document_prefix,
  filesSha256: Object.fromEntries(Object.entries(m.files).map(([f, s]) => [f, s.sha256])),
});

/** Creates or upgrades the store and fills `meta`, the self entity and the local client. */
async function prepareStore(l: Layout, model: PinnedModel): Promise<DatabaseSync> {
  ensurePrivateDir(l.dataDir);
  const db = openStore(l.storeFile, { mode: l.config.server.mode });
  await migrate(db, l.storeFile);
  initStore({ db, clock: systemClock, ids: idSource() }, {
    embedding: embeddingMeta(model),
    localClient: l.config.server.mode === "local" ? l.config.client_defaults.coding : undefined,
  });
  return db;
}

/** The local token: created at first start (32 random bytes, base64url), user-only. */
function localToken(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  ensurePrivateDir(path.dirname(file));
  const token = randomBytes(32).toString("base64url");
  writeFileAtomic(file, `${token}\n`, { private: true });
  return token;
}

async function init(l: Layout): Promise<void> {
  const model = activeModel();
  const dir = modelDir(l.modelsDir, model);
  process.stderr.write(`Embedding model: ${model.repo} (${model.dtype}), used under the Gemma Terms of Use: ${GEMMA_TERMS}\n`);
  ensurePrivateDir(l.modelsDir);
  await downloadModel(dir, model, fetch, (f) => process.stderr.write(`  verified ${f}\n`));
  const db = await prepareStore(l, model);
  db.close();
  process.stdout.write(`${JSON.stringify({ ok: true, store: l.storeFile, schema_version: SCHEMA_VERSION, model: model.modelId })}\n`);
}

async function start(l: Layout, port: number, ephemeral: boolean): Promise<void> {
  if (l.config.server.mode !== "local") throw new Error("this build serves local mode only (start --local)");
  const [host] = l.config.server.listen.split(":");
  if (host !== "127.0.0.1") throw new Error(`local mode binds 127.0.0.1 only, not ${host ?? "?"} (topology-and-ipc.md §4)`);
  const model = activeModel();
  const embedder = await OnnxEmbedder.load(modelDir(l.modelsDir, model), model).catch((e: unknown) => {
    throw new Error(`${(e as Error).message}; run \`memory-anywhere-server init\` to download the model`);
  });
  let db: DatabaseSync;
  if (ephemeral) db = await prepareStore(l, model);
  else {
    if (!existsSync(l.storeFile)) throw new Error(`no store at ${l.storeFile}; run \`memory-anywhere-server init\``);
    db = openStore(l.storeFile, { mode: "local" });
    if (schemaVersion(db) === 0) throw new Error(`the store at ${l.storeFile} is empty; run \`memory-anywhere-server init\``);
  }
  const app = new App({ db, config: l.config, embedder });
  const token = localToken(l.tokenFile);
  const logger = new Logger();
  const server = createHttpServer({ app, port, localToken: token, logger });
  const worker = new JobWorker(app, ephemeral ? undefined : l.storeFile);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  worker.start();
  logger.log({ level: "info", op: "start", outcome: `listening 127.0.0.1:${port}`, reason: ephemeral ? "ephemeral" : "local" });
  if (ephemeral) process.stdout.write(`${JSON.stringify({ listen: `127.0.0.1:${port}`, token_file: l.tokenFile })}\n`);

  const stop = (): void => {
    worker.stop();
    server.close();
    server.closeAllConnections();
    db.close();
    void embedder.release();
    if (ephemeral) rmSync(l.dataDir, { recursive: true, force: true, maxRetries: 5 });
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string" }, local: { type: "boolean" }, port: { type: "string" }, ephemeral: { type: "boolean" },
      "dry-run": { type: "boolean" }, canonical: { type: "boolean" }, content: { type: "boolean" }, out: { type: "string" },
    },
    allowPositionals: false,
  });
  const ephemeralDir = values.ephemeral ? mkdtempSync(path.join(os.tmpdir(), "memory-anywhere ")) : undefined;
  const l = layout(values.config, ephemeralDir);
  switch (command) {
    case "start": {
      const port = Number(values.port ?? l.config.server.listen.split(":")[1] ?? "47821");
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port ${values.port ?? ""}`);
      return start(l, port, values.ephemeral === true);
    }
    case "init":
      return init(l);
    case "migrate": {
      const db = openStore(l.storeFile, { mode: l.config.server.mode });
      try {
        if (values["dry-run"]) {
          process.stdout.write(`${JSON.stringify({ from: schemaVersion(db), to: SCHEMA_VERSION })}\n`);
          return;
        }
        process.stdout.write(`${JSON.stringify(await migrate(db, l.storeFile))}\n`);
      } finally {
        db.close();
      }
      return;
    }
    case "dump": {
      if (!values.canonical) throw new Error("dump needs --canonical");
      const db = openStore(l.storeFile, { mode: l.config.server.mode });
      const text = (values.content ? contentDump(db) : canonicalDump(db)).map((x) => `${x}\n`).join("");
      db.close();
      if (values.out) writeFileSync(values.out, text);
      else process.stdout.write(text);
      return;
    }
    case "backup": {
      if (!values.out) throw new Error("backup needs --out <file>");
      const db = openStore(l.storeFile, { mode: l.config.server.mode });
      db.prepare("VACUUM INTO ?").run(values.out);
      db.close();
      return;
    }
    case "version":
      process.stdout.write(`${JSON.stringify({ server: SERVER_VERSION, schema: SCHEMA_VERSION, policy: POLICY_VERSION })}\n`);
      return;
    default:
      throw new Error(`usage: memory-anywhere-server <start|init|migrate|dump|backup|version> [flags]`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`memory-anywhere-server: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
