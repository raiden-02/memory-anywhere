// Test stores: migrated, initialised, with a fixed clock and seeded ids, so that two stores fed the
// same writes are identical.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { defaultConfig } from "../../src/config/schema.ts";
import { steppingClock } from "../../src/store/clock.ts";
import type { StoreContext } from "../../src/store/context.ts";
import { openStore } from "../../src/store/db.ts";
import { initStore, type EmbeddingMeta } from "../../src/store/init.ts";
import { migrate } from "../../src/store/migrate.ts";

export const T0_MS = Date.parse("2026-11-10T12:00:00.000Z");

export const FAKE_EMBEDDING: EmbeddingMeta = {
  modelId: "test-model@0",
  dim: 8,
  queryPrefix: "q: ",
  docPrefix: "d: ",
  filesSha256: { "model.onnx": "0".repeat(64) },
};

export interface TestStore extends StoreContext {
  readonly file: string;
  close(): void;
}

/** A migrated, initialised store in a temporary folder with a space in its path. */
export async function testStore(options: { seed?: number; file?: string } = {}): Promise<TestStore> {
  const dir = options.file ? undefined : mkdtempSync(path.join(os.tmpdir(), "ma store "));
  const file = options.file ?? path.join(dir ?? "", "store.db");
  const db = openStore(file, { mode: "local" });
  await migrate(db, file);
  const ctx: StoreContext = { db, clock: steppingClock(T0_MS), ids: idSource(seededPrng(options.seed ?? 1)) };
  initStore(ctx, { embedding: FAKE_EMBEDDING, localClient: defaultConfig().client_defaults.coding });
  return {
    ...ctx,
    file,
    close: () => {
      db.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
