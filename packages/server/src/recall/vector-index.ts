// The vector side of recall (retrieval.md §2 step 3): every memory version's embedding for the
// active model, held in memory and scanned by brute force. Loaded once at start; after each write
// the server re-reads the touched memories (WriteEnv.onCommit), so the index always mirrors the
// committed `embedding` table. Ranking a query is one dot product per version (vectors are
// L2-normalized, so the dot product is the cosine).

import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../store/db.ts";

interface Entry {
  readonly memoryId: string;
  /** The memory's current version (valid_to and expired_at unset). */
  readonly current: boolean;
  readonly vector: Float32Array;
}

export interface VectorHit {
  readonly versionId: string;
  readonly memoryId: string;
  readonly cosine: number;
}

const SELECT = `SELECT e.owner_id AS version_id, v.memory_id, (v.valid_to IS NULL AND v.expired_at IS NULL) AS current, e.vector
  FROM embedding e JOIN memory_version v ON v.id = e.owner_id
  WHERE e.owner_type = 'version' AND e.model_id = ?`;

interface Row {
  readonly version_id: string;
  readonly memory_id: string;
  readonly current: number;
  readonly vector: Uint8Array;
}

const toVector = (bytes: Uint8Array): Float32Array => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

export class VectorIndex {
  readonly modelId: string;
  readonly #entries = new Map<string, Entry>();
  readonly #byMemory = new Map<string, Set<string>>();

  private constructor(modelId: string) {
    this.modelId = modelId;
  }

  /** Every version embedding of the model. */
  static load(db: DatabaseSync, modelId: string): VectorIndex {
    const index = new VectorIndex(modelId);
    for (const r of prepared(db, SELECT).all(modelId) as unknown as Row[]) index.#put(r);
    return index;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Re-reads these memories' versions from the store (after a commit, a forget, an undo or a purge). */
  sync(db: DatabaseSync, memoryIds: readonly string[]): void {
    const one = prepared(db, `${SELECT} AND v.memory_id = ?`);
    for (const memoryId of new Set(memoryIds)) {
      for (const versionId of this.#byMemory.get(memoryId) ?? []) this.#entries.delete(versionId);
      this.#byMemory.delete(memoryId);
      for (const r of one.all(this.modelId, memoryId) as unknown as Row[]) this.#put(r);
    }
  }

  /** The `k` most similar versions; past versions only when asked for. Ties break by version id. */
  search(query: Float32Array, k: number, includePast: boolean): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const [versionId, e] of this.#entries) {
      if (!includePast && !e.current) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += (query[i] as number) * (e.vector[i] as number);
      hits.push({ versionId, memoryId: e.memoryId, cosine: dot });
    }
    hits.sort((a, b) => b.cosine - a.cosine || (a.versionId < b.versionId ? -1 : 1));
    return hits.slice(0, k);
  }

  #put(r: Row): void {
    this.#entries.set(r.version_id, { memoryId: r.memory_id, current: r.current === 1, vector: toVector(r.vector) });
    const versions = this.#byMemory.get(r.memory_id) ?? new Set<string>();
    versions.add(r.version_id);
    this.#byMemory.set(r.memory_id, versions);
  }
}
