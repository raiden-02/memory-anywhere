// Schema migrations (operations.md §6). Forward only: `migrations/NNNN_name.sql`, plus an optional
// `NNNN_name.ts` exporting `up(db)` for data steps, applied in order inside one transaction each.
// `meta.schema_version` holds the number of the last applied migration. Before migrating a store
// that already has data, a copy is written next to it (`<store>.pre-migrate-<n>.db`; the `prune`
// job deletes it after 24 hours). The server refuses to start on a schema it does not expect.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sqlFile: string;
  readonly dataFile: string | undefined;
}

export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir);
  const migrations = files
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .map((f) => {
      const base = f.slice(0, -4);
      return {
        version: Number(base.slice(0, 4)),
        name: base,
        sqlFile: join(dir, f),
        dataFile: files.includes(`${base}.ts`) ? join(dir, `${base}.ts`) : undefined,
      };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 0001, 0002, … without gaps; found ${m.name}`);
  });
  return migrations;
}

/** The schema version this build of the server expects. */
export function latestVersion(dir: string = MIGRATIONS_DIR): number {
  return listMigrations(dir).length;
}

/** `meta.schema_version`, or 0 for an empty store. */
export function schemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  /** The pre-migrate copy, when one was written. */
  readonly backup: string | undefined;
}

/** Applies every pending migration. `storeFile` is used to name the pre-migrate copy. */
export async function migrate(db: DatabaseSync, storeFile: string | undefined, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const from = schemaVersion(db);
  const pending = listMigrations(dir).filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, backup: undefined };
  let backup: string | undefined;
  if (from > 0 && storeFile && storeFile !== ":memory:") {
    backup = `${storeFile}.pre-migrate-${from}.db`;
    db.prepare("VACUUM INTO ?").run(backup);
  }
  for (const m of pending) {
    // import() needs a file URL: a bare Windows path such as C:\x is not a valid module specifier.
    const data = m.dataFile ? ((await import(pathToFileURL(m.dataFile).href)) as { up: (db: DatabaseSync) => void }) : undefined;
    transaction(db, () => {
      db.exec(readFileSync(m.sqlFile, "utf8"));
      data?.up(db);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(m.version),
      );
    });
  }
  return { from, to: pending.at(-1)?.version ?? from, backup };
}

/** Throws unless the store's schema is exactly the one this server expects. */
export function assertSchemaCurrent(db: DatabaseSync, dir: string = MIGRATIONS_DIR): void {
  const have = schemaVersion(db);
  const want = latestVersion(dir);
  if (have < want) throw new Error(`store schema ${have} is older than ${want}; run \`memory-anywhere-server migrate\``);
  if (have > want) throw new Error(`store schema ${have} is newer than this server (${want}); upgrade the server`);
}
