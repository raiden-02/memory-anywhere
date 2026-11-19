// Test helpers: the synthetic fixtures of evals/datasets/i/imports (persona Alex), a temporary home
// outside any repository, and a tiny ZIP writer so tests build export ZIPs at run time.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { SourceFile } from "../src/types.ts";

export const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "evals", "datasets", "i", "imports");

export function fixtureText(name: string): string {
	return readFileSync(path.join(FIXTURES, name), "utf8");
}

export function fixture(name: string, mtime?: Date): SourceFile {
	return { name, text: fixtureText(name), ...(mtime ? { mtime } : {}) };
}

export const file = (text: string, name = "input.txt"): SourceFile => ({ name, text });

/** A temporary folder in the OS temp dir (outside this repository), with a space in its path. */
export function tempDir(): {
	dir: string;
	write: (rel: string, text: string | Uint8Array) => string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(path.join(os.tmpdir(), "ma importers "));
	return {
		dir,
		write: (rel, text) => {
			const p = path.join(dir, rel);
			mkdirSync(path.dirname(p), { recursive: true });
			writeFileSync(p, text);
			return p;
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
	};
}

/** A ZIP of `entries` (deflated unless `stored`), as a data export would be. */
export function zipOf(entries: readonly { name: string; data: string | Buffer; stored?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
		const body = e.stored ? data : deflateRawSync(data);
		const name = Buffer.from(e.name, "utf8");
		const crc = crc32(data) >>> 0;
		const method = e.stored ? 0 : 8;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, body);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const dir = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(dir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, dir, eocd]);
}
