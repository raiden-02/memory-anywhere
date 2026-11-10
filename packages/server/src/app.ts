// One running store: the database, the embedder, the in-memory vector index and the session-start
// cache, plus the write and read environments built on them. The HTTP layer, the job worker and
// the CLI all work through an App, so there is one write path and one read path (topology §3).

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { idSource, type IdSource } from "@memory-anywhere/contracts/ids";
import type { ServerConfigT } from "./config/schema.ts";
import type { Embedder } from "./embed/types.ts";
import type { ReadEnv } from "./recall/recall.ts";
import { SessionStartCache } from "./recall/session-start.ts";
import { VectorIndex } from "./recall/vector-index.ts";
import { systemClock, type Clock } from "./store/clock.ts";
import type { StoreContext } from "./store/context.ts";
import { prepared } from "./store/db.ts";
import { assertSchemaCurrent, latestVersion } from "./store/migrate.ts";
import type { WriteEnv } from "./write/pipeline.ts";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const SERVER_VERSION = PACKAGE.version;
/** Clients one minor version behind are still served (topology-and-ipc.md §11). */
export const MIN_CLIENT_VERSION = ((): string => {
  const [major, minor] = SERVER_VERSION.split(".").map(Number) as [number, number];
  return `${major}.${Math.max(0, minor - 1)}.0`;
})();
export const SCHEMA_VERSION = latestVersion();

export interface AppOptions {
  readonly db: DatabaseSync;
  readonly config: ServerConfigT;
  readonly embedder: Embedder;
  readonly clock?: Clock;
  readonly ids?: IdSource;
}

export class App {
  readonly ctx: StoreContext;
  readonly config: ServerConfigT;
  readonly embedder: Embedder;
  readonly index: VectorIndex;
  readonly sessions = new SessionStartCache();
  readonly write: WriteEnv;
  readonly read: ReadEnv;

  constructor(o: AppOptions) {
    assertSchemaCurrent(o.db);
    const modelId = (prepared(o.db, "SELECT value FROM meta WHERE key = 'embedding_model_id'").get() as { value: string } | undefined)?.value;
    if (modelId !== o.embedder.modelId) {
      throw new Error(`the store was embedded with ${modelId ?? "no model"}, but the server loaded ${o.embedder.modelId}; re-embedding is a migration (data-model.md §8)`);
    }
    this.ctx = { db: o.db, clock: o.clock ?? systemClock, ids: o.ids ?? idSource() };
    this.config = o.config;
    this.embedder = o.embedder;
    this.index = VectorIndex.load(o.db, o.embedder.modelId);
    this.write = { ctx: this.ctx, config: o.config, embedder: o.embedder, onCommit: (ids) => this.committed(ids) };
    this.read = { ctx: this.ctx, config: o.config, embedder: o.embedder, index: this.index };
  }

  /** After every commit: the touched memories' vectors are re-read and cached contexts dropped. */
  committed(memoryIds: readonly string[]): void {
    this.index.sync(this.ctx.db, memoryIds);
    this.sessions.invalidate();
  }

  /** `ok` of /v1/health (operations.md §5): the store is open and writable (the model loaded before the App existed). */
  healthy(): boolean {
    try {
      return this.ctx.db.isOpen && (prepared(this.ctx.db, "PRAGMA query_only").get() as { query_only: number }).query_only === 0;
    } catch {
      return false;
    }
  }
}
