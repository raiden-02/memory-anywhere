// The embedding model as the rest of the server sees it (retrieval.md §10; data-model.md §8).
// Vectors are L2-normalized, so cosine similarity is a dot product. Prefixes are applied inside:
// documents are embedded as `doc_prefix + text`, queries as `query_prefix + text`.

export interface Embedder {
  /** `<hf repo>@<revision>:<dtype>`, written to `meta.embedding_model_id` and `embedding.model_id`. */
  readonly modelId: string;
  readonly dim: number;
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}
