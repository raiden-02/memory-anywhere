// The WAL SQLite deletes on its last close must be zeroed, not just freed (store/wal-hold.ts).
//
// A test cannot read freed disk blocks, so it reads the inode instead: a "spy" hard link made to
// the WAL stands in for the raw disk. It keeps seeing the file's blocks after every other name is
// gone, which is exactly what S-PURGE's scan of /dev/nvme0n1 sees on an eval stack.

import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactStore } from "../src/ops/compact.ts";
import { openStore } from "../src/store/db.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function storeWithCanary(canary: string): { file: string; spy: string; close: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "ma-walhold-"));
	dirs.push(dir);
	const file = path.join(dir, "store.db");
	const db = openStore(file, { mode: "aws" });
	db.exec("CREATE TABLE note (text TEXT)");
	db.prepare("INSERT INTO note VALUES (?)").run(`Keeps a spare key code ${canary}`);
	const spy = path.join(dir, "raw-disk.spy");
	linkSync(`${file}-wal`, spy);
	return { file, spy, close: () => db.close() };
}

const held = (file: string): string[] =>
	readdirSync(path.dirname(file)).filter((f) => f.startsWith("store.db-wal.held-"));
const zeroed = (spy: string): boolean => {
	const bytes = readFileSync(spy);
	return bytes.length > 0 && bytes.every((b) => b === 0);
};

describe("aws mode: a WAL SQLite deletes is zeroed before its blocks are freed", () => {
	it("SQLite's own close leaves the text in the deleted WAL; the held name keeps it reachable", () => {
		const s = storeWithCanary("Quarry1a2b3c");
		expect(held(s.file)).toHaveLength(1);
		s.close();
		expect(existsSync(`${s.file}-wal`)).toBe(false); // SQLite deleted its name ...
		expect(readFileSync(s.spy).includes("Quarry1a2b3c")).toBe(true); // ... without wiping it
		expect(held(s.file)).toHaveLength(1);
	});

	it("compaction zeroes the held WAL and leaves no held name", () => {
		const s = storeWithCanary("Quarry4d5e6f");
		s.close();
		compactStore(s.file);
		expect(zeroed(s.spy)).toBe(true);
		expect(held(s.file)).toEqual([]);
	});

	it("the next open (a restart or reboot) zeroes the WAL of the previous run and holds its own", () => {
		const s = storeWithCanary("Quarry7a8b9c");
		s.close();
		const db = openStore(s.file, { mode: "aws" });
		try {
			expect(zeroed(s.spy)).toBe(true);
			expect(held(s.file)).toHaveLength(1); // the new live WAL
		} finally {
			db.close();
		}
	});

	it("never releases the live WAL while a connection uses it", () => {
		const s = storeWithCanary("Quarry0d1e2f");
		const second = openStore(s.file, { mode: "aws" }); // e.g. a CLI command beside the server
		try {
			expect(readFileSync(s.spy).includes("Quarry0d1e2f")).toBe(true);
			expect(held(s.file)).toHaveLength(1);
		} finally {
			second.close();
			s.close();
		}
	});

	it("local mode holds nothing: the PC store has no raw-disk guarantee and no maintenance timer", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "ma-walhold-"));
		dirs.push(dir);
		const db = openStore(path.join(dir, "store.db"), { mode: "local" });
		db.exec("CREATE TABLE t (x)");
		db.close();
		expect(readdirSync(dir).filter((f) => f.includes(".held-"))).toEqual([]);
	});
});
