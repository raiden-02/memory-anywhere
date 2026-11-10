// BM25-only baseline (evals.md §7): FTS5 bm25() over content + excerpt + aliases, with the
// query built exactly as retrieval.md §3 builds it: tokens lowercased, stopwords removed, each
// double-quoted, joined with OR, weights bm25(memory_fts, 0, 1.0, 0.5, 0.5), top 50.

import { DatabaseSync } from "node:sqlite";
import type { Doc } from "../harness/lme.ts";
import { STOPWORDS } from "../harness/stopwords.ts";

export function ftsQuery(text: string): string {
  const tokens = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(tokens)].map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** Index one question's haystack and rank its documents for the query. */
export function bm25Rank(docs: Doc[], query: string, k = 50): string[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(version_id UNINDEXED, content, excerpts, aliases,
      tokenize = 'porter unicode61 remove_diacritics 2')`);
    const ins = db.prepare("INSERT INTO memory_fts (version_id, content, excerpts, aliases) VALUES (?, ?, '', '')");
    db.exec("BEGIN");
    for (const d of docs) ins.run(d.id, d.text);
    db.exec("COMMIT");
    const q = ftsQuery(query);
    if (!q) return [];
    return (
      db.prepare("SELECT version_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts, 0, 1.0, 0.5, 0.5) LIMIT ?").all(q, k) as {
        version_id: string;
      }[]
    ).map((r) => r.version_id);
  } finally {
    db.close();
  }
}
