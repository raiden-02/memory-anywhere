// Fetches MemoryAgentBench's Conflict Resolution split (FactConsolidation) and its entity list
// into evals/datasets/public/data/ (not committed; evals.md §2). Licence: MIT (dataset card).
//
//   node evals/datasets/public/fetch-mab.ts

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAB_DIR = join(import.meta.dirname, "data", "memoryagentbench");
const BASE = "https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main";

/** Files and their SHA-256 at the time M1 built suite W; a changed upstream file is refused. */
export const MAB_FILES = {
  "Conflict_Resolution-00000-of-00001.parquet": { path: "data/Conflict_Resolution-00000-of-00001.parquet", sha256: "24d5c3f09ce0ce15625cb9f8a98f44f0d864ca6c94d7b4ad04eb697ca3a5ff45" },
  "entity2id.json": { path: "entity2id.json", sha256: "63353aca481bc9558b502f91cb98f6fa26438796fdd7e0bc06b5a1532126e8b5" },
} as const;

const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export async function fetchMab(pins: Record<string, string> = {}): Promise<string> {
  mkdirSync(MAB_DIR, { recursive: true });
  for (const [name, f] of Object.entries(MAB_FILES)) {
    const target = join(MAB_DIR, name);
    const want = pins[name] ?? f.sha256;
    if (existsSync(target) && (!want || sha(readFileSync(target)) === want)) continue;
    const res = await fetch(`${BASE}/${f.path}`);
    if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (want && sha(buf) !== want) throw new Error(`${name}: sha256 ${sha(buf)} differs from the pinned ${want}`);
    writeFileSync(target, buf);
  }
  return MAB_DIR;
}

if (import.meta.main) {
  const dir = await fetchMab();
  for (const name of Object.keys(MAB_FILES)) console.log(`${sha(readFileSync(join(dir, name)))}  ${name}`);
}
