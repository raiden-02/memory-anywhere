// The embedder: EmbeddingGemma through onnxruntime-node on the CPU, tokenized by
// @huggingface/tokenizers (ADR-0005; no transformers.js). The ONNX export already pools and
// L2-normalizes into its `sentence_embedding` output. Inference runs one batch at a time, so a
// burst of saves cannot start several CPU-heavy sessions at once.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import type { Embedder } from "./types.ts";
import { ModelHashError, verifyModel, type PinnedModel } from "./manifest.ts";

export class OnnxEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;
  readonly #model: PinnedModel;
  readonly #session: ort.InferenceSession;
  readonly #tokenizer: Tokenizer;
  readonly #padId: number;
  readonly #hasTokenTypes: boolean;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(model: PinnedModel, session: ort.InferenceSession, tokenizer: Tokenizer, padId: number) {
    this.modelId = model.modelId;
    this.dim = model.dims;
    this.#model = model;
    this.#session = session;
    this.#tokenizer = tokenizer;
    this.#padId = padId;
    this.#hasTokenTypes = session.inputNames.includes("token_type_ids");
  }

  /** Verifies every file against the manifest, then opens the model. */
  static async load(dir: string, model: PinnedModel, options: { threads?: number } = {}): Promise<OnnxEmbedder> {
    const bad = await verifyModel(dir, model);
    if (bad.length > 0) throw new ModelHashError(bad);
    const tokJson = JSON.parse(readFileSync(path.join(dir, "tokenizer.json"), "utf8")) as object;
    const tokConfig = JSON.parse(readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")) as { pad_token?: string };
    const tokenizer = new Tokenizer(tokJson, tokConfig);
    const padId = tokenizer.token_to_id(tokConfig.pad_token ?? "<pad>") ?? 0;
    const graph = Object.keys(model.files).find((f) => f.endsWith(".onnx"));
    if (!graph) throw new Error(`model ${model.name} has no .onnx file`);
    const session = await ort.InferenceSession.create(path.join(dir, graph), {
      executionProviders: ["cpu"],
      intraOpNumThreads: options.threads ?? 0,
      graphOptimizationLevel: "all",
    });
    return new OnnxEmbedder(model, session, tokenizer, padId);
  }

  embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return this.#serial(() => this.#embed(texts.map((t) => this.#model.document_prefix + t)));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.#serial(() => this.#embed([this.#model.query_prefix + text]));
    return v as Float32Array;
  }

  async release(): Promise<void> {
    await this.#queue;
    await this.#session.release();
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Token ids with special tokens, at most `max_tokens` (the closing special token is kept). */
  #tokenize(text: string): number[] {
    const ids = this.#tokenizer.encode(text).ids;
    const max = this.#model.max_tokens;
    return ids.length <= max ? ids : [...ids.slice(0, max - 1), ids[ids.length - 1] ?? 0];
  }

  async #embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const seqs = texts.map((t) => this.#tokenize(t));
    const len = Math.max(1, ...seqs.map((s) => s.length));
    const n = seqs.length;
    const ids = new BigInt64Array(n * len).fill(BigInt(this.#padId));
    const mask = new BigInt64Array(n * len);
    seqs.forEach((s, i) => s.forEach((id, j) => {
      ids[i * len + j] = BigInt(id);
      mask[i * len + j] = 1n;
    }));
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", ids, [n, len]),
      attention_mask: new ort.Tensor("int64", mask, [n, len]),
    };
    if (this.#hasTokenTypes) feeds["token_type_ids"] = new ort.Tensor("int64", new BigInt64Array(n * len), [n, len]);
    const out = await this.#session.run(feeds);
    const t = out["sentence_embedding"];
    if (!t) throw new Error("model has no sentence_embedding output");
    const data = t.data as Float32Array;
    return Array.from({ length: n }, (_, i) => normalize(data.slice(i * this.dim, (i + 1) * this.dim)));
  }
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  return v.map((x) => x / norm);
}
