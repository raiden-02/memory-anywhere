#!/usr/bin/env node
// `memory-anywhere-server` (config-and-cli.md §4.4): start, init, migrate, dump, backup, maint, version.
//
// Local mode keeps everything under the user's data folder: the store in `{data}\server`, the
// model files in `{data}\models`, and the owner credential in `{data}\local.token`, readable only
// by the user. `server.toml` can point elsewhere; `--ephemeral` uses a temporary folder that is
// deleted at exit (tests and suite C).
//
// aws mode (deployment-aws.md §4) serves a unix socket behind Caddy, writes outbound files to the
// outbox next to that socket, and starts in restored state when `{data}/maint/restored` exists.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { idSource } from "@memory-anywhere/contracts/ids";
import { currentPaths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir, writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import { App, SCHEMA_VERSION, SERVER_VERSION } from "./app.ts";
import { localTokenAuth } from "./api/grant.ts";
import { createAuth } from "./auth/index.ts";
import { OwnerCredentials } from "./auth/owner.ts";
import { Alerts } from "./ops/alerts.ts";
import { defaultConfig, listenTarget, parseConfig, type ListenTarget, type ServerConfigT } from "./config/schema.ts";
import { activeModel, downloadModel, modelDir, type PinnedModel } from "./embed/manifest.ts";
import { OnnxEmbedder } from "./embed/onnx.ts";
import { awsDoor, localDoor } from "./http/front.ts";
import { fileSink, Logger, stdoutSink, teeSink } from "./http/log.ts";
import { createHttpServer } from "./http/server.ts";
import { JobWorker } from "./jobs/worker.ts";
import { compactStore } from "./ops/compact.ts";
import { FileOutbox, NO_OUTBOX, outboxDirFor } from "./ops/outbox.ts";
import { enterRestoredState, restoredFlagFile } from "./ops/restored.ts";
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

/** Opens an existing store for serving: aws mode migrates a store an older release (or a restore) left behind. */
async function openForServing(l: Layout): Promise<DatabaseSync> {
  if (!existsSync(l.storeFile)) throw new Error(`no store at ${l.storeFile}; run \`memory-anywhere-server init\``);
  const db = openStore(l.storeFile, { mode: l.config.server.mode });
  const version = schemaVersion(db);
  if (version === 0) throw new Error(`the store at ${l.storeFile} is empty; run \`memory-anywhere-server init\``);
  if (l.config.server.mode === "aws" && version < SCHEMA_VERSION) await migrate(db, l.storeFile);
  return db;
}

/** Listens on a loopback port or a unix socket (replacing a stale socket file, then group-only 0660). */
async function listen(server: Server, target: ListenTarget): Promise<string> {
  if (target.kind === "unix") rmSync(target.path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (target.kind === "unix") server.listen(target.path, resolve);
    else server.listen(target.port, "127.0.0.1", resolve);
  });
  if (target.kind === "unix") {
    chmodSync(target.path, 0o660);
    return `unix:${target.path}`;
  }
  return `127.0.0.1:${target.port}`;
}

async function start(l: Layout, target: ListenTarget, ephemeral: boolean, rateLimits: boolean): Promise<void> {
  const { mode } = l.config.server;
  const model = activeModel();
  const embedder = await OnnxEmbedder.load(modelDir(l.modelsDir, model), model).catch((e: unknown) => {
    throw new Error(`${(e as Error).message}; run \`memory-anywhere-server init\` to download the model`);
  });
  const db = ephemeral ? await prepareStore(l, model) : await openForServing(l);
  const outbox = mode === "aws" && target.kind === "unix" ? new FileOutbox(outboxDirFor(target.path)) : NO_OUTBOX;
  const app = new App({ db, config: l.config, embedder, rateLimits, outbox });
  if (mode === "aws") enterRestoredState(app.ctx, app.alerts, restoredFlagFile(l.dataDir));

  // Local mode runs hidden, so its log also goes to {data}\server\server.log; aws mode logs to the journal.
  const logger = new Logger(mode === "aws" || ephemeral ? stdoutSink : teeSink(stdoutSink, fileSink(path.join(l.dataDir, "server.log"))));
  let server: Server;
  const hourly: (() => void)[] = [];
  if (mode === "aws") {
    const door = awsDoor(l.config.server.public_url);
    const auth = createAuth({ app, door, logger });
    auth.owner.issueFirstSetupToken();
    hourly.push(() => auth.owner.hourly());
    server = createHttpServer({ app, door, authenticate: auth.authenticate, mounts: auth.mounts, logger });
  } else {
    server = createHttpServer({ app, door: localDoor(target.kind === "tcp" ? target.port : 0), authenticate: localTokenAuth(localToken(l.tokenFile)), logger });
  }
  const worker = new JobWorker(app, ephemeral ? undefined : l.storeFile, hourly);
  const where = await listen(server, target);
  worker.start();
  logger.log({ level: "info", op: "start", outcome: `listening ${where}`, reason: ephemeral ? "ephemeral" : mode });
  if (ephemeral) process.stdout.write(`${JSON.stringify({ listen: where, token_file: l.tokenFile })}\n`);

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

/** The owner commands run beside a live aws server: the store, its outbox and alerts, without an App. */
function ownerTools(l: Layout): { owner: OwnerCredentials; close: () => void } {
  const target = listenTarget(l.config);
  if (l.config.server.mode !== "aws" || target.kind !== "unix") throw new Error("this command is for an aws-mode server");
  const db = openStore(l.storeFile, { mode: "aws" });
  const ctx = { db, clock: systemClock, ids: idSource() };
  const outbox = new FileOutbox(outboxDirFor(target.path));
  return { owner: new OwnerCredentials(ctx, outbox, new Alerts(ctx, outbox)), close: () => db.close() };
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string" }, local: { type: "boolean" }, port: { type: "string" }, ephemeral: { type: "boolean" },
      "dry-run": { type: "boolean" }, "no-rate-limits": { type: "boolean" }, canonical: { type: "boolean" }, content: { type: "boolean" }, out: { type: "string" },
      compact: { type: "boolean" }, renew: { type: "boolean" }, schedule: { type: "boolean" }, cancel: { type: "boolean" },
    },
    allowPositionals: false,
  });
  const ephemeralDir = values.ephemeral ? mkdtempSync(path.join(os.tmpdir(), "memory-anywhere ")) : undefined;
  const l = layout(values.config, ephemeralDir);
  switch (command) {
    case "start": {
      if (values.local && l.config.server.mode !== "local") throw new Error("--local, but server.toml sets mode = \"aws\"");
      if (values["no-rate-limits"] && !values.ephemeral) throw new Error("--no-rate-limits is only for --ephemeral servers (latency evals)");
      if (values.port !== undefined && l.config.server.mode !== "local") throw new Error("--port is for local mode; aws mode listens on server.listen");
      const target = listenTarget(l.config, values.port === undefined ? undefined : Number(values.port));
      return start(l, target, values.ephemeral === true, values["no-rate-limits"] !== true);
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
    case "maint": {
      if (!values.compact) throw new Error("maint needs --compact");
      process.stdout.write(`${JSON.stringify({ ok: true, ...compactStore(l.storeFile) })}\n`);
      return;
    }
    case "setup-token": {
      // Run by ma-operator.sh setup-link through SSM Run Command, beside the running server (auth-and-security.md §3.1 step 6).
      if (!values.renew) throw new Error("setup-token needs --renew");
      const { owner, close } = ownerTools(l);
      try {
        owner.renewSetupToken();
        process.stdout.write(`${JSON.stringify({ ok: true, expires_in_s: 1800 })}\n`);
      } finally {
        close();
      }
      return;
    }
    case "reset-owner": {
      // Break-glass (§3.3): --schedule takes effect in 24 hours; --cancel stops it.
      if (values.schedule === values.cancel) throw new Error("reset-owner needs --schedule or --cancel");
      const { owner, close } = ownerTools(l);
      try {
        process.stdout.write(`${JSON.stringify(values.schedule ? { ok: true, reset: owner.scheduleReset() } : { ok: owner.cancelReset() })}\n`);
      } finally {
        close();
      }
      return;
    }
    case "version":
      process.stdout.write(`${JSON.stringify({ server: SERVER_VERSION, schema: SCHEMA_VERSION, policy: POLICY_VERSION })}\n`);
      return;
    default:
      throw new Error(`usage: memory-anywhere-server <start|init|migrate|dump|backup|maint|setup-token|reset-owner|version> [flags]`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`memory-anywhere-server: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
