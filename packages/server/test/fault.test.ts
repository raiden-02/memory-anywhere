// Fault injection (operations.md §6, §9): a process killed while migrating. Each migration runs in
// one transaction, so whatever moment it dies at, the store holds exactly the migrations that committed,
// passes integrity_check, and the next `migrate` finishes the job. MA_FAULT_RUNS sets the number
// of kills (the nightly workflow runs 100).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { openStore } from "../src/store/db.ts";
import { latestVersion, listMigrations, migrate, schemaVersion } from "../src/store/migrate.ts";

const RUNS = Number(process.env["MA_FAULT_RUNS"] ?? 3);

/** Every schema object's SQL, by name. */
const schemaOf = (db: DatabaseSync): Record<string, string> =>
  Object.fromEntries((db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]));

/** The schema of a fresh store after exactly the first `version` migrations (each file applied as `migrate` does). */
async function referenceSchema(version: number): Promise<Record<string, string>> {
  const db = openStore(":memory:", { mode: "local" });
  try {
    for (const m of listMigrations().slice(0, version)) {
      db.exec(readFileSync(m.sqlFile, "utf8"));
      if (m.dataFile) ((await import(pathToFileURL(m.dataFile).href)) as { up: (d: DatabaseSync) => void }).up(db);
    }
    return schemaOf(db);
  } finally {
    db.close();
  }
}

it(`leaves the store whole after a migration is killed (${RUNS} kills)`, async () => {
  for (let run = 0; run < RUNS; run++) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ma fault "));
    const file = path.join(dir, "store.db");
    try {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "fault", "migrate-child.ts"), file], { stdio: ["ignore", "pipe", "ignore"] });
      // Taken now: a child that finishes before the kill must not be waited for forever.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 40)));
      child.kill("SIGKILL");
      await exited;

      const db = openStore(file, { mode: "local" });
      try {
        expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, `run ${run}`).toBe("ok");
        // Never a half-applied migration: the schema is exactly that of the first `version` migrations.
        const version = schemaVersion(db);
        expect(schemaOf(db), `run ${run}`).toEqual(await referenceSchema(version));
        await migrate(db, file);
        expect(schemaVersion(db), `run ${run}`).toBe(latestVersion());
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}, 60_000 + RUNS * 3_000);
