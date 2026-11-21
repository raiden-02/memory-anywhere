// A minimal ZIP reader for the vendors' data exports (conversations.json inside a ZIP), so the
// client needs no dependency for it. It reads the central directory at the end of the file, then
// each wanted entry's local header and data:
//
//   [local header][data] [local header][data] … [central directory entries][zip64 EOCD?][EOCD]
//        ▲ offset of each entry ────────────────────────────┘                       ▲ found by scanning back
//
// Supported: stored (0) and deflate (8) entries, ZIP64 sizes and offsets, CRC-32 check.
// Refused: encrypted entries, other methods, and an entry over `MAX_ENTRY_BYTES` uncompressed.

import { readFileSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";

/** The largest entry this reader inflates: well above any chat export, far below a zip bomb's appetite. */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

export interface ZipEntry {
	readonly name: string;
	readonly method: number;
	readonly flags: number;
	readonly crc: number;
	readonly compressedSize: number;
	readonly size: number;
	readonly localOffset: number;
}

export class ZipError extends Error {
	override readonly name = "ZipError";
}

function findEocd(buf: Buffer): number {
	const stop = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD) return i;
	throw new ZipError("not a ZIP file (no end of central directory)");
}

/** The central directory's entry count, offset and size, from the ZIP64 record when the classic one overflows. */
function directory(buf: Buffer): { count: number; offset: number } {
	const eocd = findEocd(buf);
	let count = buf.readUInt16LE(eocd + 10);
	let offset = buf.readUInt32LE(eocd + 16);
	const locator = eocd - 20;
	if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_LOCATOR) {
		const at = Number(buf.readBigUInt64LE(locator + 8));
		if (at + 56 > buf.length || buf.readUInt32LE(at) !== ZIP64_EOCD) throw new ZipError("broken ZIP64 end record");
		count = Number(buf.readBigUInt64LE(at + 32));
		offset = Number(buf.readBigUInt64LE(at + 48));
	}
	return { count, offset };
}

/** Every entry in the central directory. */
export function listEntries(buf: Buffer): ZipEntry[] {
	const { count, offset } = directory(buf);
	const entries: ZipEntry[] = [];
	let p = offset;
	for (let n = 0; n < count; n++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError("broken central directory");
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const crc = buf.readUInt32LE(p + 16);
		let compressedSize = buf.readUInt32LE(p + 20);
		let size = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		let localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
		// ZIP64 extra field (0x0001): the 64-bit values, in this order, for each 32-bit field that is 0xFFFFFFFF.
		for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
			const id = buf.readUInt16LE(e);
			const len = buf.readUInt16LE(e + 2);
			if (id === 0x0001) {
				let q = e + 4;
				const next = (): number => {
					const v = Number(buf.readBigUInt64LE(q));
					q += 8;
					return v;
				};
				if (size === MAX_U32) size = next();
				if (compressedSize === MAX_U32) compressedSize = next();
				if (localOffset === MAX_U32) localOffset = next();
			}
			e += 4 + len;
		}
		entries.push({ name, method, flags, crc, compressedSize, size, localOffset });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/** The uncompressed bytes of one entry, CRC-checked. */
export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
	if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted`);
	if (entry.size > MAX_ENTRY_BYTES) throw new ZipError(`${entry.name} is larger than ${MAX_ENTRY_BYTES} bytes`);
	const p = entry.localOffset;
	if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new ZipError(`broken local header for ${entry.name}`);
	const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
	const raw = buf.subarray(start, start + entry.compressedSize);
	let data: Buffer;
	if (entry.method === 0) data = raw;
	else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
	else
		throw new ZipError(`${entry.name} uses compression method ${entry.method}; only stored and deflate are supported`);
	if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc >>> 0)
		throw new ZipError(`${entry.name} is corrupt (size or CRC-32 mismatch)`);
	return data;
}

/** The entries of a ZIP (a path, or its bytes already read) whose base name matches `want`, as UTF-8 text, in directory order. */
export function readZipTexts(zip: string | Buffer, want: RegExp): { name: string; text: string }[] {
	const buf = typeof zip === "string" ? readFileSync(zip) : zip;
	return listEntries(buf)
		.filter((e) => !e.name.endsWith("/") && want.test(e.name.split("/").at(-1) ?? ""))
		.map((e) => ({ name: e.name, text: readEntry(buf, e).toString("utf8") }));
}
