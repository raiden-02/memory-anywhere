// Client logs (operations.md §1): `{data}\logs\client.log` and `hooks.log`, rotated at 1 MB with
// five files kept. Lines carry codes and ids, never prompt or memory text.

import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "@memory-anywhere/contracts/secure-fs";

const MAX_BYTES = 1_048_576;
const KEEP = 5;

function rotate(file: string): void {
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
  rmSync(`${file}.${KEEP - 1}`, { force: true });
  for (let i = KEEP - 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
}

/** Appends one JSON line; never throws (a hook must not fail because its log could not be written). */
export function logLine(file: string, fields: Record<string, string | number | boolean | undefined>): void {
  try {
    ensurePrivateDir(path.dirname(file));
    rotate(file);
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
  } catch {
    /* logging is best effort */
  }
}
