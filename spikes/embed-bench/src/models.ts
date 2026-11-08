// Q14 candidates (ADR-0005), each pinned to a Hugging Face commit. Prefixes and pooling follow
// each model's card: EmbeddingGemma's ONNX export already outputs the pooled, normalised
// sentence_embedding; bge-small uses the CLS token; e5-small uses mean pooling.

export type Pooling = "sentence_embedding" | "cls" | "mean";

export interface Candidate {
  /** Short id used in result files: <family>-<dtype>. */
  id: string;
  repo: string;
  revision: string;
  /** ONNX graph file, plus its external-data file when the export has one. */
  files: string[];
  dtype: "q8" | "q4";
  dims: number;
  pooling: Pooling;
  queryPrefix: string;
  docPrefix: string;
  /** Tokens per input; every model is capped at the same length for a fair comparison. */
  maxTokens: number;
  licence: string;
}

const GEMMA = { repo: "onnx-community/embeddinggemma-300m-ONNX", revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66" };
const BGE = { repo: "Xenova/bge-small-en-v1.5", revision: "ea104dacec62c0de699686887e3f920caeb4f3e3" };
const E5 = { repo: "Xenova/e5-small-v2", revision: "02af79985278377e65c724a76275707cb0333c70" };
export const MAX_TOKENS = 512;

export const CANDIDATES: Candidate[] = [
  {
    id: "embeddinggemma-300m-q8",
    ...GEMMA,
    files: ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"],
    dtype: "q8",
    dims: 768,
    pooling: "sentence_embedding",
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    maxTokens: MAX_TOKENS,
    licence: "Gemma Terms of Use (redistribution and on-demand download allowed with the terms and notice)",
  },
  {
    id: "embeddinggemma-300m-q4",
    ...GEMMA,
    files: ["onnx/model_q4.onnx", "onnx/model_q4.onnx_data"],
    dtype: "q4",
    dims: 768,
    pooling: "sentence_embedding",
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    maxTokens: MAX_TOKENS,
    licence: "Gemma Terms of Use (redistribution and on-demand download allowed with the terms and notice)",
  },
  {
    id: "bge-small-en-v1.5-q8",
    ...BGE,
    files: ["onnx/model_quantized.onnx"],
    dtype: "q8",
    dims: 384,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    docPrefix: "",
    maxTokens: MAX_TOKENS,
    licence: "MIT (BAAI/bge-small-en-v1.5)",
  },
  {
    id: "e5-small-v2-q8",
    ...E5,
    files: ["onnx/model_quantized.onnx"],
    dtype: "q8",
    dims: 384,
    pooling: "mean",
    queryPrefix: "query: ",
    docPrefix: "passage: ",
    maxTokens: MAX_TOKENS,
    licence: "MIT (intfloat/e5-small-v2)",
  },
];

export const TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json"];
