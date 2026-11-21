// `memory-anywhere-server maint --compact` (deployment-aws.md §4, `ma-maint`), run with the server
// and Litestream stopped. Deleting a row frees its pages but leaves their bytes in the file, so a
// purged memory could still be read from the volume or a later snapshot. Compaction writes a
// fresh copy that never held them and overwrites the old files with zeros before removing them:
//
//   store.db ──VACUUM INTO──► store.new.db (created 0660 first, as the store; fsync)
//   store.db{,-wal,-shm} ──rename──► store.old.db{,-wal,-shm}
//   store.new.db ──rename──► store.db                (a store.db exists at every moment)
//   store.old.db{,-wal,-shm} ──zero-fill, fsync, delete──► gone
//   store.db-wal.held-*  ──zero-fill, fsync, delete──► gone   (the WALs SQLite deleted, wal-hold.ts)
//
// The WAL is never checkpointed with TRUNCATE here: that would free its blocks unzeroed. VACUUM
// INTO reads the database through the WAL, so the copy is complete without a checkpoint.
//
// A run that stopped part-way is finished by the next run: a leftover store.old.db is zeroed and
// deleted first, and a lone store.new.db (no store.db) is renamed into place.

import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { createStoreFile, openStore } from "../store/db.ts";
import { releaseHeldWals, zeroAndDelete } from "../store/wal-hold.ts";

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
	// VACUUM INTO fills an empty file it is given, keeping its mode: Litestream must be able to write it.
	createStoreFile(fresh);
	const db = openStore(storeFile, { mode: "aws" });
	try {
		db.prepare("VACUUM INTO ?").run(fresh);
	} finally {
		// The last connection: SQLite deletes the WAL's name here; its held link keeps the blocks.
		db.close();
	}
	fsyncFile(fresh);
	for (const s of SIDECARS) if (existsSync(storeFile + s)) renameSync(storeFile + s, old + s);
	renameSync(fresh, storeFile);
	for (const s of SIDECARS) zeroAndDelete(old + s);
	releaseHeldWals(storeFile);
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
