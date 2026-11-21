// Keeping purged text out of freed disk blocks (deployment-aws.md §5.3).
//
// SQLite deletes the WAL file when the last connection closes, and it does so without
// overwriting it: the file's blocks go back to the file system still holding the latest
// writes, a purged memory's text among them, readable from the raw volume and from EBS
// snapshots until something reuses them. SQLite has no hook for "wipe before delete".
//
// So every aws-mode connection gives the WAL a second name, a hard link in the data
// directory. SQLite's delete then removes only its own name; the file and its blocks stay
// until we zero them:
//
//   open (aws)        store.db-wal ═══ inode 41 ═══ store.db-wal.held-41
//   last close        (name gone)      inode 41 ═══ store.db-wal.held-41
//   next open/compact                  inode 41 ◄── zeroed in place, then deleted
//
// A held WAL is released (zeroed and deleted) once it is no longer the live WAL: by the next
// aws-mode open, which sees a different live WAL, and by compaction, which runs with every
// connection closed. Nothing else can use a released inode: a WAL file keeps its inode while
// any connection is open, and no connection can open a name SQLite has deleted.
//
// What this does not cover: a TRUNCATE checkpoint cuts the live WAL short and frees its tail
// unzeroed. The server never runs one in aws mode; Litestream runs one only when the WAL
// passes its truncate-page-n threshold (about 470 MB), far above this store's size.

import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	openSync,
	readdirSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import path from "node:path";

const HELD = /^(.+)-wal\.held-(\d+)$/u;
const ZEROS = Buffer.alloc(1 << 20);

/** The live WAL's inode number, or undefined if there is no WAL. */
function walInode(storeFile: string): string | undefined {
	try {
		return statSync(`${storeFile}-wal`, { bigint: true }).ino.toString();
	} catch {
		return undefined;
	}
}

/** Gives the live WAL a second name, so SQLite's delete leaves its blocks for us to zero. */
export function holdWal(storeFile: string): void {
	const ino = walInode(storeFile);
	if (ino === undefined) return;
	const held = `${storeFile}-wal.held-${ino}`;
	if (!existsSync(held)) linkSync(`${storeFile}-wal`, held);
}

/** Zeroes and deletes every held WAL except the live one. Returns how many it released. */
export function releaseHeldWals(storeFile: string): number {
	const live = walInode(storeFile);
	const dir = path.dirname(storeFile);
	const base = path.basename(storeFile);
	let released = 0;
	for (const name of readdirSync(dir)) {
		const m = HELD.exec(name);
		if (!m || m[1] !== base || m[2] === live) continue;
		zeroAndDelete(path.join(dir, name));
		released++;
	}
	return released;
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
