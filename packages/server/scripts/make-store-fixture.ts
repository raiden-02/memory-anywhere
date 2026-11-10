// Writes packages/server/test/fixtures/store-v<N>.db: a store at the current schema version with
// seeded ids and a fixed clock (operations.md §6). Run once when a migration is added, then commit
// the file; later migrations are tested by upgrading it. Usage: node scripts/make-store-fixture.ts
//
// The fixture holds no real data. Keys in `meta` are random and meaningless outside the fixture.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { idSource, seededPrng } from "@memory-anywhere/contracts/ids";
import { defaultConfig } from "../src/config/schema.ts";
import { steppingClock } from "../src/store/clock.ts";
import { openStore } from "../src/store/db.ts";
import { initStore } from "../src/store/init.ts";
import { latestVersion, migrate } from "../src/store/migrate.ts";

const version = latestVersion();
const file = join(import.meta.dirname, `../test/fixtures/store-v${version}.db`);
rmSync(file, { force: true });
const db = openStore(file, { mode: "local" });
await migrate(db, file);
initStore(
  { db, clock: steppingClock(Date.parse("2026-11-10T00:00:00.000Z")), ids: idSource(seededPrng(42)) },
  {
    embedding: { modelId: "fixture-model@0", dim: 8, queryPrefix: "q: ", docPrefix: "d: ", filesSha256: {} },
    localClient: defaultConfig().client_defaults.coding,
  },
);
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;");
db.close();
console.log(`wrote ${file}`);
