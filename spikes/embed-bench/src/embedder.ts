// onnxruntime-node + @huggingface/tokenizers embedder (ADR-0005: no transformers.js).
// Returns L2-normalised float32 vectors.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import { modelDir } from "./fetch-models.ts";
import type { Candidate } from "./models.ts";

export interface EmbedderOptions {
  /** "cpu" (what the server uses) or "dml" (DirectML GPU on Windows, for corpus embedding only). */
  device?: "cpu" | "dml";
  threads?: number;
}

export class Embedder {
  readonly candidate: Candidate;
  private readonly session: ort.InferenceSession;
  private readonly tokenizer: Tokenizer;
  private readonly inputNames: Set<string>;
  private readonly padId: number;

  private constructor(c: Candidate, session: ort.InferenceSession, tokenizer: Tokenizer, padId: number) {
    this.candidate = c;
    this.session = session;
    this.tokenizer = tokenizer;
    this.inputNames = new Set(session.inputNames);
    this.padId = padId;
  }

  static async load(c: Candidate, opts: EmbedderOptions = {}): Promise<Embedder> {
    const dir = modelDir(c);
    const tokJson = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as { added_tokens?: { id: number; content: string }[] };
    const tokConfig = JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")) as { pad_token?: string };
    const tokenizer = new Tokenizer(tokJson, tokConfig);
    const padId = tokenizer.token_to_id(tokConfig.pad_token ?? "[PAD]") ?? 0;
    const session = await ort.InferenceSession.create(join(dir, c.files[0] ?? ""), {
      executionProviders: opts.device === "dml" ? ["dml", "cpu"] : ["cpu"],
      intraOpNumThreads: opts.threads ?? 0,
      graphOptimizationLevel: "all",
    });
    return new Embedder(c, session, tokenizer, padId);
  }

  /** Token ids with special tokens, capped at maxTokens (the last special token is kept). */
  tokenize(text: string): number[] {
    const ids = this.tokenizer.encode(text).ids;
    const max = this.candidate.maxTokens;
    if (ids.length <= max) return ids;
    const last = ids[ids.length - 1] ?? 0;
    return [...ids.slice(0, max - 1), last];
  }

  async embed(texts: string[], kind: "query" | "doc"): Promise<Float32Array[]> {
    const prefix = kind === "query" ? this.candidate.queryPrefix : this.candidate.docPrefix;
    const seqs = texts.map((t) => this.tokenize(prefix + t));
    const len = Math.max(1, ...seqs.map((s) => s.length));
    const n = seqs.length;
    const ids = new BigInt64Array(n * len).fill(BigInt(this.padId));
    const mask = new BigInt64Array(n * len);
    seqs.forEach((s, i) => {
      s.forEach((id, j) => {
        ids[i * len + j] = BigInt(id);
        mask[i * len + j] = 1n;
      });
    });
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", ids, [n, len]),
      attention_mask: new ort.Tensor("int64", mask, [n, len]),
    };
    if (this.inputNames.has("token_type_ids")) feeds["token_type_ids"] = new ort.Tensor("int64", new BigInt64Array(n * len), [n, len]);
    const out = await this.session.run(feeds);
    const dims = this.candidate.dims;
    const vectors: Float32Array[] = [];
    if (this.candidate.pooling === "sentence_embedding") {
      const t = out["sentence_embedding"];
      if (!t) throw new Error("model has no sentence_embedding output");
      const data = t.data as Float32Array;
      for (let i = 0; i < n; i++) vectors.push(normalize(data.slice(i * dims, (i + 1) * dims)));
    } else {
      const t = out["last_hidden_state"];
      if (!t) throw new Error("model has no last_hidden_state output");
      const data = t.data as Float32Array;
      for (let i = 0; i < n; i++) {
        const v = new Float32Array(dims);
        if (this.candidate.pooling === "cls") {
          v.set(data.subarray(i * len * dims, i * len * dims + dims));
        } else {
          let count = 0;
          for (let j = 0; j < len; j++) {
            if (mask[i * len + j] === 0n) continue;
            count++;
            const off = (i * len + j) * dims;
            for (let d = 0; d < dims; d++) v[d] = (v[d] ?? 0) + (data[off + d] ?? 0);
          }
          for (let d = 0; d < dims; d++) v[d] = (v[d] ?? 0) / Math.max(1, count);
        }
        vectors.push(normalize(v));
      }
    }
    return vectors;
  }

  async release(): Promise<void> {
    await this.session.release();
  }
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
