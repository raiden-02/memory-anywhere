// Download the pinned candidate files into spikes/embed-bench/out/models/ (git-ignored) and record
// each file's SHA-256 in out/models/hashes.json (copied into models.json for the chosen model).
//
//   node spikes/embed-bench/src/fetch-models.ts [<candidate id> ...]

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CANDIDATES, TOKENIZER_FILES, type Candidate } from "./models.ts";

export const MODELS_DIR = join(import.meta.dirname, "..", "out", "models");

export function modelDir(c: Pick<Candidate, "repo" | "revision">): string {
  return join(MODELS_DIR, `${c.repo.replace("/", "__")}@${c.revision.slice(0, 12)}`);
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function download(repo: string, revision: string, file: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${file}`);
  if (!res.ok || !res.body) throw new Error(`${repo}/${file}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
}

export async function fetchModels(ids?: string[]): Promise<Record<string, string>> {
  const hashFile = join(MODELS_DIR, "hashes.json");
  const hashes: Record<string, string> = existsSync(hashFile) ? (JSON.parse(readFileSync(hashFile, "utf8")) as Record<string, string>) : {};
  for (const c of CANDIDATES.filter((c) => !ids?.length || ids.includes(c.id))) {
    for (const f of [...TOKENIZER_FILES, ...c.files]) {
      const dest = join(modelDir(c), f);
      await download(c.repo, c.revision, f, dest);
      hashes[`${c.repo}@${c.revision}/${f}`] = await sha256(dest);
      process.stderr.write(`${c.id}: ${f}\n`);
    }
  }
  mkdirSync(MODELS_DIR, { recursive: true });
  writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + "\n");
  return hashes;
}

if (import.meta.main) await fetchModels(process.argv.slice(2));
