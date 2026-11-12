// Dynamic sections (memory-policy.md §9.2): once a week, Unsorted memories that keep coming up
// together become a section of their own.
//
//   Unsorted memories ──embed──► average-link clustering (stop below the threshold)
//     └─ clusters with ≥ 3 members from ≥ 2 sessions, mean pairwise cosine ≥ threshold
//          └─ name = two highest TF-IDF content words ("Sourdough and Baking")
//               └─ at most 2 new sections per run, 16 active in total; beyond that, a suggestion
//
// Without an LLM the name comes only from TF-IDF. A new section starts unapproved: only its name
// appears in the section map until the owner approves it.

import { contentWords, norm } from "@memory-anywhere/contracts/normalize";
import type { ServerConfigT } from "../config/schema.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { SECTION } from "../write/resolve.ts";
import { instructionHit } from "../write/screens.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9 &-]{0,31}$/u;
/** The newest Unsorted memories considered per run; clustering is quadratic in memory and cubic in time. */
const MAX_MEMBERS = 1500;

interface Member {
  readonly memoryId: string;
  readonly content: string;
  readonly vector: Float32Array;
  readonly sessions: readonly string[];
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};

/**
 * Average-link agglomerative clustering: repeatedly merge the two clusters with the highest mean
 * cosine, until that mean falls below the threshold. Cluster similarities are kept in a matrix and
 * updated with the Lance–Williams rule, sim(a∪b, k) = (|a|·sim(a,k) + |b|·sim(b,k)) / (|a|+|b|).
 */
export function averageLink(vectors: readonly Float32Array[], threshold: number): number[][] {
  const n = vectors.length;
  const sim = vectors.map((a) => Float64Array.from(vectors, (b) => dot(a, b)));
  const members: (number[] | undefined)[] = vectors.map((_, i) => [i]);
  for (;;) {
    let best = { a: -1, b: -1, score: -Infinity };
    for (let a = 0; a < n; a++) {
      if (!members[a]) continue;
      const row = sim[a] as Float64Array;
      for (let b = a + 1; b < n; b++) if (members[b] && (row[b] as number) > best.score) best = { a, b, score: row[b] as number };
    }
    if (best.a < 0 || best.score < threshold) break;
    const ma = members[best.a] as number[];
    const mb = members[best.b] as number[];
    for (let k = 0; k < n; k++) {
      if (!members[k] || k === best.a || k === best.b) continue;
      const v = (ma.length * ((sim[best.a] as Float64Array)[k] as number) + mb.length * ((sim[best.b] as Float64Array)[k] as number)) / (ma.length + mb.length);
      (sim[best.a] as Float64Array)[k] = v;
      (sim[k] as Float64Array)[best.a] = v;
    }
    members[best.a] = [...ma, ...mb].sort((x, y) => x - y);
    members[best.b] = undefined;
  }
  return members.filter((m): m is number[] => m !== undefined);
}

/** Mean cosine over distinct pairs of a cluster. */
function meanPairwise(vectors: readonly Float32Array[]): number {
  let s = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      s += dot(vectors[i] as Float32Array, vectors[j] as Float32Array);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : s / pairs;
}

/** The cluster's two highest TF-IDF content words, title-cased: "Sourdough and Baking". */
export function tfidfName(cluster: readonly string[], corpus: readonly string[]): string | undefined {
  const docFreq = new Map<string, number>();
  for (const doc of corpus) for (const w of new Set(contentWords(doc))) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  const tf = new Map<string, number>();
  for (const doc of cluster) for (const w of contentWords(doc)) if (/^\p{L}{3,}$/u.test(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
  const scored = [...tf].map(([w, f]) => ({ w, score: f * Math.log((1 + corpus.length) / (1 + (docFreq.get(w) ?? 0))) }))
    .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));
  const words = scored.slice(0, 2).map((s) => s.w.charAt(0).toUpperCase() + s.w.slice(1));
  return words.length === 2 ? `${words[0]} and ${words[1]}` : undefined;
}

export interface ClusterRunResult {
  readonly created: readonly string[];
  readonly suggested: number;
}

export function clusterSections(ctx: StoreContext, config: ServerConfigT, modelId: string): ClusterRunResult {
  const { db } = ctx;
  const threshold = Number((prepared(db, "SELECT value FROM meta WHERE key = 'sections_cluster_threshold'").get() as { value: string }).value);
  const rows = prepared(db, `SELECT m.id, v.content, e.vector FROM memory m
      JOIN memory_version v ON v.memory_id = m.id AND v.valid_to IS NULL AND v.expired_at IS NULL
      JOIN embedding e ON e.owner_type = 'version' AND e.owner_id = v.id AND e.model_id = ?
     WHERE m.section_id = ? AND m.status = 'active' AND v.trust_tier <= 2 ORDER BY m.id DESC LIMIT ?`).all(modelId, SECTION.unsorted, MAX_MEMBERS) as {
    id: string; content: string; vector: Uint8Array;
  }[];
  const sessionsOf = prepared(db, "SELECT DISTINCT s.session_key FROM memory_source ms JOIN source s ON s.id = ms.source_id WHERE ms.memory_id = ?");
  const members: Member[] = rows.map((r) => ({
    memoryId: r.id,
    content: r.content,
    vector: new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)),
    sessions: (sessionsOf.all(r.id) as { session_key: string }[]).map((s) => s.session_key),
  }));
  const corpus = members.map((m) => m.content);
  const candidates = averageLink(members.map((m) => m.vector), threshold)
    .map((idx) => idx.map((i) => members[i] as Member))
    .filter((c) => c.length >= config.sections.min_members)
    .filter((c) => new Set(c.flatMap((m) => m.sessions)).size >= 2)
    .filter((c) => meanPairwise(c.map((m) => m.vector)) >= threshold)
    .sort((a, b) => b.length - a.length || (a[0]?.memoryId ?? "").localeCompare(b[0]?.memoryId ?? ""));

  return transaction(db, () => {
    const taken = new Set((prepared(db, "SELECT name, aliases_json FROM section").all() as { name: string; aliases_json: string }[])
      .flatMap((s) => [s.name, ...(JSON.parse(s.aliases_json) as string[])].map(norm)));
    let active = (prepared(db, "SELECT count(*) AS n FROM section WHERE status = 'active'").get() as { n: number }).n;
    const created: string[] = [];
    let suggested = 0;
    for (const cluster of candidates) {
      const name = tfidfName(cluster.map((m) => m.content), corpus);
      if (!name || !NAME.test(name) || taken.has(norm(name)) || instructionHit(name, "fact")) continue;
      const ids = cluster.map((m) => m.memoryId);
      if (created.length >= config.sections.max_new_per_run || active >= config.sections.max_active) {
        prepared(db, "INSERT INTO review_item (id, kind, payload_json, client_id, created_at) VALUES (?, 'section_proposal', ?, 'job:section_cluster', ?)")
          .run(ctx.ids.newId("rev", ctx.clock.now()), JSON.stringify({ name, memory_ids: ids }), iso(ctx.clock.now()));
        suggested++;
        continue;
      }
      const id = ctx.ids.newId("sec", ctx.clock.now());
      const sort = (prepared(db, "SELECT coalesce(max(sort_order), 0) + 10 AS n FROM section").get() as { n: number }).n;
      prepared(db, "INSERT INTO section (id, name, description, aliases_json, origin, approved, status, sort_order, created_at, created_by) VALUES (?, ?, NULL, '[]', 'dynamic', 0, 'active', ?, ?, 'job:section_cluster')")
        .run(id, name, sort, iso(ctx.clock.now()));
      const move = prepared(db, "UPDATE memory SET section_id = ?, updated_at = ? WHERE id = ?");
      for (const memoryId of ids) move.run(id, iso(ctx.clock.now()), memoryId);
      appendEvent(ctx, { actor: "job:section_cluster", op: "section.create", refs: { section_id: id }, undo: { moved: ids } });
      taken.add(norm(name));
      created.push(id);
      active++;
    }
    return { created, suggested };
  });
}
