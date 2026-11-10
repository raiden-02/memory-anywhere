// The pinned embedding model (retrieval.md §10, ADR-0005): `config/models.json` names the model,
// its Hugging Face revision and the SHA-256 of every file. Files live in
// `{models dir}/<model id>@<revision>/`, are downloaded once at install, and are checked against
// the manifest before the server uses them; a mismatch stops the server.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const MANIFEST_FILE = fileURLToPath(new URL("../../../../config/models.json", import.meta.url));

const ModelSpec = z.object({
  repo: z.string(),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), url: z.url() })),
  dtype: z.string(),
  dims: z.int().positive(),
  max_tokens: z.int().positive(),
  query_prefix: z.string(),
  document_prefix: z.string(),
  licence: z.string(),
});
const Manifest = z.object({ active: z.string(), models: z.record(z.string(), ModelSpec) });

export interface PinnedModel extends z.infer<typeof ModelSpec> {
  /** The manifest key, e.g. `embeddinggemma-300m-q4`. */
  readonly name: string;
  /** `<hf repo>@<revision>:<dtype>`: `meta.embedding_model_id` and `embedding.model_id`. */
  readonly modelId: string;
}

export function activeModel(manifestFile: string = MANIFEST_FILE): PinnedModel {
  const m = Manifest.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
  const spec = m.models[m.active];
  if (!spec) throw new Error(`models.json: active model ${m.active} is not listed`);
  return { ...spec, name: m.active, modelId: `${spec.repo}@${spec.revision}:${spec.dtype}` };
}

/** `{models dir}/<name>@<first 12 of revision>`, short enough for Windows paths. */
export const modelDir = (modelsDir: string, model: PinnedModel): string => path.join(modelsDir, `${model.name}@${model.revision.slice(0, 12)}`);

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Files that are missing or whose hash differs from the manifest (empty when the model is usable). */
export async function verifyModel(dir: string, model: PinnedModel): Promise<string[]> {
  const bad: string[] = [];
  for (const [file, { sha256 }] of Object.entries(model.files)) {
    const p = path.join(dir, file);
    if (!existsSync(p) || (await sha256File(p)) !== sha256) bad.push(file);
  }
  return bad;
}

export class ModelHashError extends Error {
  readonly files: readonly string[];
  constructor(files: readonly string[]) {
    super(`embedding model files missing or modified: ${files.join(", ")}`);
    this.files = files;
  }
}

/**
 * Downloads every file that is missing or wrong, each into `<file>.part` first, and keeps it only
 * if its hash matches. Never called at run time: only by `init` (retrieval.md §10).
 */
export async function downloadModel(dir: string, model: PinnedModel, fetchImpl: typeof fetch = fetch, onFile?: (file: string) => void): Promise<void> {
  for (const file of await verifyModel(dir, model)) {
    const spec = model.files[file];
    if (!spec) continue;
    const dest = path.join(dir, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetchImpl(spec.url);
    if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(part));
    if ((await sha256File(part)) !== spec.sha256) {
      rmSync(part, { force: true });
      throw new ModelHashError([file]);
    }
    renameSync(part, dest);
    onFile?.(file);
  }
}
