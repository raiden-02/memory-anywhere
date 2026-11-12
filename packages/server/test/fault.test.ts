// Fault injection (operations.md §6, §9): a process killed while migrating. Each migration runs in
// one transaction, so whatever moment it dies at, the store is either untouched or fully migrated,
// passes integrity_check, and the next `migrate` finishes the job. MA_FAULT_RUNS sets the number
// of kills (the nightly workflow runs 100).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openStore } from "../src/store/db.ts";
import { latestVersion, migrate, schemaVersion } from "../src/store/migrate.ts";

const RUNS = Number(process.env["MA_FAULT_RUNS"] ?? 3);

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
        const version = schemaVersion(db);
        const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
        // Untouched (no tables at all) or complete: never a half-applied schema.
        if (version === 0) expect(tables, `run ${run}`).toBe(0);
        else expect(version, `run ${run}`).toBe(latestVersion());
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
