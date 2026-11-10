// Opening the store and running write transactions (data-model.md §1, write-path.md §11).
//
// The store is one SQLite file opened with Node's built-in `node:sqlite` (ADR-0006). Every
// connection runs the PRAGMAs of data-model.md §1. Every write runs inside `BEGIN IMMEDIATE`, so
// the write lock is taken up front and a write never has to upgrade a read lock; `SQLITE_BUSY` at
// BEGIN is retried 5 times, 50 ms apart.

import { closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Mode = "local" | "aws";

export interface OpenOptions {
  /** aws mode: Litestream owns checkpoints, so automatic checkpoints are off. */
  readonly mode: Mode;
}

/**
 * Opens (and if needed creates) the store at `file`. A new file is created with mode 0660 before
 * SQLite opens it, so the WAL and shared-memory files SQLite creates inherit that mode
 * (spec-issues #14; on Windows the mode is not used).
 */
export function openStore(file: string, options: OpenOptions): DatabaseSync {
  if (file !== ":memory:" && !existsSync(file)) closeSync(openSync(file, "wx", 0o660));
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
  `);
  if (options.mode === "aws") db.exec("PRAGMA wal_autocheckpoint = 0;");
  return db;
}

const BUSY_RETRIES = 5;
const BUSY_WAIT_MS = 50;

function isBusy(e: unknown): boolean {
  return e instanceof Error && /SQLITE_BUSY|database is locked/i.test(e.message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `body` inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws. Nested calls run
 * inside the outer transaction. Embeddings must be computed before calling this (write-path.md
 * §11): nothing slow may run while the write lock is held.
 */
export function transaction<T>(db: DatabaseSync, body: () => T): T {
  if (db.isTransaction) return body();
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (e) {
      if (!isBusy(e) || attempt >= BUSY_RETRIES) throw e;
      sleepSync(BUSY_WAIT_MS);
    }
  }
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The first row of `sql`, or undefined. */
export function one<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Every row of `sql`. */
export function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params);
}
