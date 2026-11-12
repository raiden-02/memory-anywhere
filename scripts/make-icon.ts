// Writes the plugin icon (Claude Code's validator wants a square PNG, 512–2048 px): a dark tile
// with three linked dots, the same memory reached from several apps. Drawn pixel by pixel and
// encoded with node:zlib, so the file is reproducible without an image library.
//
//   node scripts/make-icon.ts

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZE = 512;
const BG = [24, 32, 48];
const FG = [240, 244, 250];
const DOTS = [[256, 150], [150, 340], [362, 340]] as const;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Distance from (x, y) to the segment a–b. */
function segment(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const [ax, ay] = a as [number, number];
  const [bx, by] = b as [number, number];
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

export function iconPng(): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 3);
    for (let x = 0; x < SIZE; x++) {
      const onDot = DOTS.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < 46);
      const onLink = DOTS.some((a, i) => segment(x, y, a, DOTS[(i + 1) % DOTS.length] as readonly number[]) < 12);
      const c = onDot || onLink ? FG : BG;
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

if (import.meta.main) {
  const target = join(import.meta.dirname, "..", "plugins", "claude-code", ".claude-plugin", "icon.png");
  writeFileSync(target, iconPng());
  console.log(`wrote ${target}`);
}
