// Test stores: migrated, initialised, with a fixed clock and seeded ids, so that two stores fed the
// same writes are identical; plus a deterministic fake embedder and a write environment.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { contentWords } from "@memory-anywhere/contracts/normalize";
import { defaultConfig, type ServerConfigT } from "../../src/config/schema.ts";
import type { Embedder } from "../../src/embed/types.ts";
import { steppingClock } from "../../src/store/clock.ts";
import type { StoreContext } from "../../src/store/context.ts";
import { openStore } from "../../src/store/db.ts";
import { initStore, LOCAL_CLIENT_ID, type EmbeddingMeta } from "../../src/store/init.ts";
import { migrate } from "../../src/store/migrate.ts";
import type { WriteEnv } from "../../src/write/pipeline.ts";
import type { Caller, SaveRequest } from "../../src/write/types.ts";

export const T0_MS = Date.parse("2026-11-10T12:00:00.000Z");
export const DIM = 64;
export const REPO = "rk_0123456789abcdef0123456789abcdef";

export const FAKE_EMBEDDING: EmbeddingMeta = {
  modelId: "fake-bow@1",
  dim: DIM,
  queryPrefix: "q: ",
  docPrefix: "d: ",
  filesSha256: { "model.onnx": "0".repeat(64) },
};

/** Bag of content words hashed into DIM buckets, L2-normalized: equal text → 1, unrelated → ~0. */
export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const w of contentWords(text)) {
    const h = createHash("sha256").update(w).digest();
    v[(h[0] ?? 0) % DIM] = (v[(h[0] ?? 0) % DIM] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export const fakeEmbedder: Embedder = {
  modelId: FAKE_EMBEDDING.modelId,
  dim: DIM,
  embedDocuments: async (texts) => texts.map(fakeVector),
  embedQuery: async (text) => fakeVector(text),
};

export interface TestStore extends StoreContext {
  readonly file: string;
  close(): void;
}

/** A migrated, initialised store; on disk in a folder with a space in its path, or in memory. */
export async function testStore(options: { seed?: number; memory?: boolean } = {}): Promise<TestStore> {
  const dir = options.memory ? undefined : mkdtempSync(path.join(os.tmpdir(), "ma store "));
  const file = dir ? path.join(dir, "store.db") : ":memory:";
  const db = openStore(file, { mode: "local" });
  await migrate(db, file);
  const ctx: StoreContext = { db, clock: steppingClock(T0_MS), ids: idSource(seededPrng(options.seed ?? 1)) };
  initStore(ctx, { embedding: FAKE_EMBEDDING, localClient: defaultConfig().client_defaults.coding });
  db.prepare("INSERT INTO repo (repo_key, display_name, enabled, capture, enabled_at) VALUES (?, 'test repo', 1, 0, '2026-11-10T00:00:00.000Z')").run(REPO);
  db.prepare(
    `INSERT INTO client_policy (client_id, display_name, vendor, class, read, write, section_allow_json, created_at)
     VALUES (?, 'Test chat', 'claude', 'chat', 1, 1, '["*"]', '2026-11-10T00:00:00.000Z')`,
  ).run(CHAT_CLIENT_ID);
  return {
    ...ctx,
    file,
    close: () => {
      db.close();
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export function writeEnv(store: StoreContext, config: ServerConfigT = defaultConfig()): WriteEnv {
  return { ctx: store, config, embedder: fakeEmbedder };
}

/** The local coding client calling through the proxy, in the enabled test repo. */
export function localCaller(overrides: Partial<Caller> = {}): Caller {
  return {
    clientId: LOCAL_CLIENT_ID, clientClass: "coding", channel: "mcp", tier: 2, sessionKey: `${LOCAL_CLIENT_ID}:pxy_session_1`, repoKey: REPO,
    tool: "claude-code", floored: false, canElicit: false, elicitationAnswer: undefined, ...overrides,
  };
}

export const CHAT_CLIENT_ID = "cli_chat";

/** A chat app (T2); no prompt check on user_words, so tests stay fast. */
export function chatCaller(overrides: Partial<Caller> = {}): Caller {
  return localCaller({ clientId: CHAT_CLIENT_ID, clientClass: "chat", tool: "claude", repoKey: undefined, sessionKey: `${CHAT_CLIENT_ID}:1`, ...overrides });
}

/** The owner (T0, admin channel). */
export const ownerCaller = (): Caller => localCaller({ channel: "admin", tier: 0, sessionKey: "admin" });

export function saveReq(content: string, overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    content, kind: "fact", why_durable: "lasting fact about the user", explicit_request: false, entity: "self", scope: "global", change: "update",
    ...overrides,
  };
}
