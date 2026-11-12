// `memory-anywhere-server maint --compact` (deployment-aws.md §4, `ma-maint`), run with the server
// and Litestream stopped. Deleting a row frees its pages but leaves their bytes in the file, so a
// purged memory could still be read from the volume or a later snapshot. Compaction writes a
// fresh copy that never held them and overwrites the old file with zeros before removing it:
//
//   store.db ──VACUUM INTO──► store.new.db (fsync)
//   store.db{,-wal,-shm} ──rename──► store.old.db{,-wal,-shm}
//   store.new.db ──rename──► store.db                (a store.db exists at every moment)
//   store.old.db{,-wal,-shm} ──zero-fill, fsync, delete──► gone
//
// A run that stopped part-way is finished by the next run: a leftover store.old.db is zeroed and
// deleted first, and a lone store.new.db (no store.db) is renamed into place.

import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { openStore } from "../store/db.ts";

const ZEROS = Buffer.alloc(1 << 20);
const SIDECARS = ["", "-wal", "-shm"] as const;

export interface CompactResult {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export function compactStore(storeFile: string): CompactResult {
  const fresh = `${storeFile.replace(/\.db$/u, "")}.new.db`;
  const old = `${storeFile.replace(/\.db$/u, "")}.old.db`;
  // Finish an interrupted run.
  for (const s of SIDECARS) zeroAndDelete(old + s);
  if (!existsSync(storeFile) && existsSync(fresh)) renameSync(fresh, storeFile);
  rmSync(fresh, { force: true });

  const bytesBefore = SIDECARS.reduce((n, s) => n + (existsSync(storeFile + s) ? statSync(storeFile + s).size : 0), 0);
  const db = openStore(storeFile, { mode: "aws" });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.prepare("VACUUM INTO ?").run(fresh);
  } finally {
    db.close();
  }
  fsyncFile(fresh);
  for (const s of SIDECARS) if (existsSync(storeFile + s)) renameSync(storeFile + s, old + s);
  renameSync(fresh, storeFile);
  for (const s of SIDECARS) zeroAndDelete(old + s);
  return { bytesBefore, bytesAfter: statSync(storeFile).size };
}

function fsyncFile(file: string): void {
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Overwrites a file in place with zeros, syncs it to disk, then deletes it (`shred -n0 -z -u`). */
export function zeroAndDelete(file: string): void {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  const fd = openSync(file, "r+");
  try {
    for (let pos = 0; pos < size; pos += ZEROS.length) writeSync(fd, ZEROS, 0, Math.min(ZEROS.length, size - pos), pos);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  rmSync(file);
}
