// The pinned embedding model (retrieval.md §10): manifest parsing, hash-checked download, and a
// smoke test of the real model. The smoke test needs the model files (≈ 200 MB); it runs when they
// are in MA_TEST_MODEL_DIR or in the M0 spike's download folder, and is skipped otherwise. CI
// caches them by hash (evals.md, P9).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { activeModel, downloadModel, ModelHashError, modelDir, verifyModel, type PinnedModel } from "../src/embed/manifest.ts";
import { OnnxEmbedder } from "../src/embed/onnx.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "ma embed "));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function fakeModel(files: Record<string, string>): PinnedModel {
  return {
    ...activeModel(),
    files: Object.fromEntries(Object.entries(files).map(([f, body]) => [f, { sha256: sha(body), url: `https://models.example.com/${f}` }])),
  };
}

const fakeFetch = (bodies: Record<string, string>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const body = bodies[String(url).replace("https://models.example.com/", "")];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  }) as typeof fetch;

describe("model manifest", () => {
  it("pins EmbeddingGemma q4 with its prefixes and a revision-scoped folder", () => {
    const m = activeModel();
    expect(m).toMatchObject({ name: "embeddinggemma-300m-q4", dims: 768, query_prefix: "task: search result | query: ", document_prefix: "title: none | text: " });
    expect(m.modelId).toBe(`onnx-community/embeddinggemma-300m-ONNX@${m.revision}:q4`);
    expect(path.basename(modelDir(path.join(tmp, "models"), m))).toBe(`embeddinggemma-300m-q4@${m.revision.slice(0, 12)}`);
  });

  it("downloads missing files, keeps only matching hashes, and reports what is wrong", async () => {
    const model = fakeModel({ "onnx/model.onnx": "graph", "tokenizer.json": "{}" });
    const dir = path.join(tmp, "dl");
    expect(await verifyModel(dir, model)).toEqual(["onnx/model.onnx", "tokenizer.json"]);
    await downloadModel(dir, model, fakeFetch({ "onnx/model.onnx": "graph", "tokenizer.json": "{}" }));
    expect(await verifyModel(dir, model)).toEqual([]);
    writeFileSync(path.join(dir, "tokenizer.json"), "{ tampered }");
    expect(await verifyModel(dir, model)).toEqual(["tokenizer.json"]);
  });

  it("refuses a download whose hash differs and leaves no partial file", async () => {
    const model = fakeModel({ "tokenizer.json": "{}" });
    const dir = path.join(tmp, "bad");
    await expect(downloadModel(dir, model, fakeFetch({ "tokenizer.json": "evil" }))).rejects.toBeInstanceOf(ModelHashError);
    expect(existsSync(path.join(dir, "tokenizer.json"))).toBe(false);
    expect(existsSync(path.join(dir, "tokenizer.json.part"))).toBe(false);
  });

  it("will not load a model whose files do not match", async () => {
    const dir = path.join(tmp, "load");
    mkdirSync(dir, { recursive: true });
    await expect(OnnxEmbedder.load(dir, activeModel())).rejects.toBeInstanceOf(ModelHashError);
  });
});

const SPIKE_DIR = path.join(import.meta.dirname, "..", "..", "..", "spikes", "embed-bench", "out", "models", "onnx-community__embeddinggemma-300m-ONNX@5090578d9565");
const REAL_DIR = process.env["MA_TEST_MODEL_DIR"] ?? SPIKE_DIR;
const haveModel = existsSync(path.join(REAL_DIR, "tokenizer.json")) && (await verifyModel(REAL_DIR, activeModel())).length === 0;

describe.runIf(haveModel)("EmbeddingGemma q4 on the CPU", () => {
  it("embeds unit vectors, and a query is closer to its answer than to an unrelated note", async () => {
    const e = await OnnxEmbedder.load(REAL_DIR, activeModel());
    try {
      const [denver, piano] = await e.embedDocuments(["Lives in Denver, Colorado", "Practises jazz piano on weekends"]);
      const q = await e.embedQuery("where does the user live");
      const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
      expect(denver?.length).toBe(768);
      expect(dot(denver as Float32Array, denver as Float32Array)).toBeCloseTo(1, 4);
      expect(dot(q, denver as Float32Array)).toBeGreaterThan(dot(q, piano as Float32Array));
      // The same call gives the same bits; padding in a larger batch moves only the last digits.
      const [one] = await e.embedDocuments(["Lives in Denver, Colorado"]);
      const [two] = await e.embedDocuments(["Lives in Denver, Colorado"]);
      expect(Array.from(two as Float32Array)).toEqual(Array.from(one as Float32Array));
      expect(dot(one as Float32Array, denver as Float32Array)).toBeGreaterThan(0.99999);
    } finally {
      await e.release();
    }
  }, 60_000);
});
