// Litestream probe (m0-spike.md Q21): a stand-in for the server's SQLite store and its
// `maint --compact` step (deployment-aws.md §4 ma-maint, §9).
//
//   probe.ts init <db>                 create the store with the data-model.md §1 PRAGMAs (aws mode)
//   probe.ts write <db> <n> [canary]   insert n rows (one holding the canary text if given)
//   probe.ts purge <db> <canary>       delete rows holding the canary + FTS optimize (no checkpoint: aws mode)
//   probe.ts checkpoint <db>           try wal_checkpoint(TRUNCATE); prints {busy, log, checkpointed}
//   probe.ts compact <db>              maint --compact: checkpoint, VACUUM INTO, fsync, zero and
//                                      replace the old files, rename
//   probe.ts dump-hash <db>            SHA-256 of an ordered dump of every table (rowid order)
//   probe.ts contains <file> <text>    exit 0 if the bytes of <file> contain <text>

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const PRAGMAS_AWS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA secure_delete = ON",
  "PRAGMA wal_autocheckpoint = 0",
];

export function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  for (const p of PRAGMAS_AWS) db.exec(p);
  return db;
}

export function init(path: string): void {
  const db = open(path);
  db.exec(`CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(version_id UNINDEXED, content, excerpts, aliases,
      tokenize = 'porter unicode61 remove_diacritics 2');`);
  db.close();
}

export function write(path: string, n: number, canary?: string): void {
  const db = open(path);
  const ins = db.prepare("INSERT INTO memory (content, created_at) VALUES (?, ?)");
  const fts = db.prepare("INSERT INTO memory_fts (version_id, content, excerpts, aliases) VALUES (?, ?, '', '')");
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const content = canary && i === 0 ? `Row holding ${canary} ${"p".repeat(1500)}` : `Probe row ${i} ${"f".repeat(400)}`;
    const r = ins.run(content, new Date().toISOString());
    fts.run(String(r.lastInsertRowid), content);
  }
  db.exec("COMMIT");
  db.close();
}

export function purge(path: string, canary: string): number {
  const db = open(path);
  db.exec("BEGIN");
  const ids = (db.prepare("SELECT id FROM memory WHERE content LIKE ?").all(`%${canary}%`) as { id: number }[]).map((r) => r.id);
  for (const id of ids) {
    db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    db.prepare("DELETE FROM memory_fts WHERE version_id = ?").run(String(id));
  }
  db.exec("COMMIT");
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
  db.close();
  return ids.length;
}

export function checkpoint(path: string): { busy: number; log: number; checkpointed: number } {
  const db = open(path);
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
  db.close();
  return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
}

/** Overwrite a file's bytes with zeros in place, fsync, then delete it (`shred -n0 -z -u`). */
function zeroAndRemove(file: string): void {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  const fd = openSync(file, "r+");
  const block = Buffer.alloc(1 << 20);
  for (let off = 0; off < size; off += block.length) writeSync(fd, block, 0, Math.min(block.length, size - off), off);
  fsyncSync(fd);
  closeSync(fd);
  unlinkSync(file);
}

/** maint --compact (deployment-aws.md §4): run with Litestream and the server stopped. */
export function compact(path: string): { before: number; after: number } {
  const before = statSync(path).size;
  const db = open(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const tmp = `${path.replace(/\.db$/, "")}.new.db`;
  if (existsSync(tmp)) unlinkSync(tmp);
  db.prepare("VACUUM INTO ?").run(tmp);
  db.close();
  const fd = openSync(tmp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  for (const f of [path, `${path}-wal`, `${path}-shm`]) zeroAndRemove(f);
  renameSync(tmp, path);
  return { before, after: statSync(path).size };
}

/** SHA-256 of an ordered dump: every table by name, its rows serialized and sorted (FTS5 shadow
 * tables are WITHOUT ROWID, so rows are ordered by content, not rowid). */
export function dumpHash(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const h = createHash("sha256");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const encode = (row: unknown) =>
      JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : typeof v === "bigint" ? v.toString() : v));
    for (const t of tables) {
      if (t === "memory_fts") continue; // the virtual table; its shadow tables (memory_fts_*) are hashed
      const rows = db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).all().map(encode).sort();
      h.update(`table ${t} ${rows.length}\n${rows.join("\n")}\n`);
    }
    return h.digest("hex");
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  /** The i-th argument, or exit with usage. */
  const arg = (i: number): string => {
    const v = args[i];
    if (v === undefined) throw new UsageError();
    return v;
  };
  try {
    switch (cmd) {
      case "init":
        init(arg(0));
        return 0;
      case "write":
        write(arg(0), Number(arg(1)), args[2]);
        return 0;
      case "purge":
        console.log(JSON.stringify({ purged: purge(arg(0), arg(1)) }));
        return 0;
      case "checkpoint":
        console.log(JSON.stringify(checkpoint(arg(0))));
        return 0;
      case "compact":
        console.log(JSON.stringify(compact(arg(0))));
        return 0;
      case "dump-hash":
        console.log(dumpHash(arg(0)));
        return 0;
      case "contains":
        return existsSync(arg(0)) && readFileSync(arg(0)).includes(arg(1)) ? 0 : 1;
      default:
        throw new UsageError();
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error("usage: probe.ts init|write|purge|checkpoint|compact|dump-hash|contains <db> [...]");
    return 2;
  }
}

class UsageError extends Error {}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
