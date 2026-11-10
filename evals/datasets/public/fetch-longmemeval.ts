// Fetch LongMemEval-S (cleaned) for suite R (evals.md §3.2). Not committed: the file is 277 MB.
// Licence: MIT (Hugging Face dataset card, xiaowu0162/longmemeval-cleaned).
//
//   node evals/datasets/public/fetch-longmemeval.ts
//
// Writes evals/datasets/public/data/longmemeval_s_cleaned.json (git-ignored) and refuses a file
// whose SHA-256 differs from the pinned revision's.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const LME_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
export const LME_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
export const LME_URL = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${LME_REVISION}/longmemeval_s_cleaned.json`;
export const DATA_DIR = join(import.meta.dirname, "data");
export const LME_FILE = join(DATA_DIR, "longmemeval_s_cleaned.json");

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export async function fetchLongMemEval(): Promise<string> {
  if (existsSync(LME_FILE) && sha256(LME_FILE) === LME_SHA256) return LME_FILE;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LME_FILE}.part`;
  const res = await fetch(LME_URL);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  const got = sha256(tmp);
  if (got !== LME_SHA256) {
    rmSync(tmp);
    throw new Error(`SHA-256 mismatch: got ${got}, pinned ${LME_SHA256}`);
  }
  renameSync(tmp, LME_FILE);
  return LME_FILE;
}

if (import.meta.main) {
  console.log(`LongMemEval-S at ${await fetchLongMemEval()} (sha256 ${LME_SHA256})`);
}
