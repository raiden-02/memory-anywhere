// What each admin page shows (auth-and-security.md §8.1), read straight from the store. Pages get
// plain rows; templates insert every string as text (auto-escaped), never as markup.

import { contentWords } from "@memory-anywhere/contracts/normalize";
import type { App } from "../app.ts";
import { DAY_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

const PAGE = 50;

export interface MemoryRow {
  readonly id: string;
  readonly content: string;
  readonly kind: string;
  readonly status: string;
  readonly section: string;
  readonly entity: string;
  readonly attribute: string | null;
  readonly tier: number;
  readonly pinned: number;
  readonly updated_at: string;
}

const MEMORY_SELECT = `SELECT m.id, coalesce(v.content, '') content, m.kind, m.status, s.name section, e.canonical_name entity, a.name attribute,
    v.trust_tier tier, m.pinned, m.updated_at
  FROM memory m
  JOIN memory_version v ON v.id = (SELECT max(id) FROM memory_version WHERE memory_id = m.id)
  JOIN section s ON s.id = m.section_id
  JOIN entity e ON e.id = m.entity_id
  LEFT JOIN attribute a ON a.id = m.attribute_id`;

export function home(app: App) {
  const db = app.ctx.db;
  const count = (sql: string, ...p: string[]): number => (prepared(db, sql).get(...p) as { n: number }).n;
  const now = iso(app.ctx.clock.now());
  return {
    reset: prepared(db, "SELECT id, effective_at FROM owner_reset WHERE executed_at IS NULL AND cancelled_at IS NULL").get() as { id: string; effective_at: string } | undefined,
    alerts: app.alerts.open(),
    counts: {
      memories: count("SELECT count(*) n FROM memory WHERE status = 'active'"),
      contested: count("SELECT count(*) n FROM memory WHERE status = 'contested'"),
      reviews: count("SELECT count(*) n FROM review_item WHERE resolved_at IS NULL"),
      observations: count("SELECT count(*) n FROM observation WHERE status = 'open'"),
      approvals: count("SELECT count(*) n FROM stepup_request WHERE approved_at IS NULL AND denied_at IS NULL AND expires_at > ?", now),
      jobsFailing: count("SELECT count(*) n FROM job WHERE status = 'dropped'"),
    },
    healthy: app.healthy(),
    llmToday: (prepared(db, "SELECT coalesce(sum(usd), 0) usd FROM llm_spend WHERE day = ? AND purpose = 'live'").get(now.slice(0, 10)) as { usd: number }).usd,
    llmCap: app.config.llm.daily_usd_cap,
  };
}

/** Search and browse (§8.1): words in the current text, narrowed by section, entity and status. */
export function memories(app: App, q: { text?: string | undefined; section?: string | undefined; entity?: string | undefined; status?: string | undefined; page?: number | undefined }): MemoryRow[] {
  const where: string[] = [];
  const params: string[] = [];
  const words = contentWords(q.text ?? "");
  if (words.length > 0) {
    where.push("m.id IN (SELECT v2.memory_id FROM memory_fts f JOIN memory_version v2 ON v2.id = f.version_id WHERE memory_fts MATCH ?)");
    params.push(words.map((w) => `"${w.replaceAll('"', "")}"`).join(" "));
  }
  if (q.section) {
    where.push("m.section_id = ?");
    params.push(q.section);
  }
  if (q.entity) {
    where.push("m.entity_id = ?");
    params.push(q.entity);
  }
  where.push(q.status ? "m.status = ?" : "m.status IN ('active','contested','pending_review')");
  if (q.status) params.push(q.status);
  const offset = Math.max(0, (q.page ?? 0) * PAGE);
  return prepared(app.ctx.db, `${MEMORY_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ${PAGE} OFFSET ${offset}`).all(...params) as unknown as MemoryRow[];
}

export function memoryDetail(app: App, id: string) {
  const db = app.ctx.db;
  const memory = prepared(db, `${MEMORY_SELECT} WHERE m.id = ?`).get(id) as MemoryRow | undefined;
  if (!memory) return undefined;
  return {
    memory,
    versions: prepared(db, `SELECT id, content, valid_from, valid_to, recorded_at, expired_at, trust_tier tier, change_kind, client_id FROM memory_version
      WHERE memory_id = ? ORDER BY recorded_at DESC, id DESC`).all(id) as { id: string; content: string | null; valid_from: string | null; valid_to: string | null; recorded_at: string; expired_at: string | null; tier: number; change_kind: string | null; client_id: string }[],
    sources: prepared(db, `SELECT s.client_id, coalesce(c.display_name, s.client_id) client, ms.observed_at, ms.user_words FROM memory_source ms
      JOIN source s ON s.id = ms.source_id LEFT JOIN client_policy c ON c.client_id = s.client_id WHERE ms.memory_id = ? ORDER BY ms.observed_at DESC`).all(id) as { client: string; observed_at: string; user_words: string | null }[],
    contested: prepared(db, `${MEMORY_SELECT} WHERE m.id IN (SELECT other_memory_id FROM memory_contest WHERE memory_id = ? AND resolved_at IS NULL
      UNION SELECT memory_id FROM memory_contest WHERE other_memory_id = ? AND resolved_at IS NULL)`).all(id, id) as unknown as MemoryRow[],
    canUndo: memory.status === "forgotten",
  };
}

export function reviews(app: App) {
  return prepared(app.ctx.db, `SELECT r.id, r.kind, r.created_at, coalesce(c.display_name, r.client_id) client,
      coalesce(v.content, json_extract(r.payload_json, '$.content'), o.content, '') content, r.memory_id
    FROM review_item r
    LEFT JOIN memory_version v ON v.id = (SELECT max(id) FROM memory_version WHERE memory_id = r.memory_id)
    LEFT JOIN observation o ON o.id = r.observation_id
    LEFT JOIN client_policy c ON c.client_id = r.client_id
    WHERE r.resolved_at IS NULL ORDER BY r.created_at`).all() as { id: string; kind: string; created_at: string; client: string; content: string; memory_id: string | null }[];
}

export function observations(app: App) {
  return prepared(app.ctx.db, `SELECT o.id, o.content, o.kind, o.mention_count, o.last_seen, o.expires_at, s.name section, coalesce(c.display_name, o.created_by_client_id) client
    FROM observation o JOIN section s ON s.id = o.section_id LEFT JOIN client_policy c ON c.client_id = o.created_by_client_id
    WHERE o.status = 'open' ORDER BY o.last_seen DESC LIMIT 200`).all() as { id: string; content: string | null; kind: string; mention_count: number; last_seen: string; expires_at: string; section: string; client: string }[];
}

/** Recent changes (§8.1): the newest events, with the memory text where there is one. */
export function changes(app: App) {
  return prepared(app.ctx.db, `SELECT e.id, e.at, e.op, coalesce(c.display_name, e.actor) actor, json_extract(e.refs_json, '$.memory_id') memory_id,
      (SELECT content FROM memory_version WHERE memory_id = json_extract(e.refs_json, '$.memory_id') ORDER BY id DESC LIMIT 1) content,
      (SELECT status FROM memory WHERE id = json_extract(e.refs_json, '$.memory_id')) status
    FROM event e LEFT JOIN client_policy c ON c.client_id = e.actor
    WHERE e.op LIKE 'memory.%' OR e.op LIKE 'review.%' OR e.op LIKE 'client.%' OR e.op LIKE 'section.%'
    ORDER BY e.id DESC LIMIT 100`).all() as { id: string; at: string; op: string; actor: string; memory_id: string | null; content: string | null; status: string | null }[];
}

/**
 * Apps and their behaviour (§8.1): grants, last use, read-budget use, and the bad-save rate (saves
 * the owner forgot or replaced within 14 days, out of its saves in the last 14 days).
 */
export function clients(app: App) {
  const db = app.ctx.db;
  const now = app.ctx.clock.now();
  const since14 = iso(now - 14 * DAY_MS);
  const since24 = iso(now - DAY_MS);
  return (prepared(db, `SELECT client_id, display_name, vendor, class, read, write, section_allow_json, save_floor, elicitation, read_budget_24h, created_at
      FROM client_policy WHERE revoked_at IS NULL ORDER BY created_at`).all() as {
      client_id: string; display_name: string; vendor: string; class: string; read: number; write: number; section_allow_json: string; save_floor: string; elicitation: string; read_budget_24h: number; created_at: string;
    }[]).map((c) => {
    const grants = prepared(db, "SELECT count(*) n, max(last_used_at) last FROM grant_meta WHERE client_id = ? AND revoked_at IS NULL").get(c.client_id) as { n: number; last: string | null };
    const saves = (prepared(db, "SELECT count(*) n FROM memory_version WHERE client_id = ? AND recorded_at > ?").get(c.client_id, since14) as { n: number }).n;
    const bad = (prepared(db, `SELECT count(DISTINCT v.memory_id) n FROM memory_version v JOIN event e ON json_extract(e.refs_json, '$.memory_id') = v.memory_id
        WHERE v.client_id = ? AND v.recorded_at > ? AND e.actor = 'owner' AND e.op IN ('memory.forget','memory.correction','memory.update','memory.resolve') AND e.at > v.recorded_at`).get(c.client_id, since14) as { n: number }).n;
    const reads = (prepared(db, "SELECT count(DISTINCT memory_id) n FROM read_ledger WHERE client_id = ? AND first_read_at > ?").get(c.client_id, since24) as { n: number }).n;
    return {
      ...c,
      restricted: c.section_allow_json !== '["*"]',
      grants: grants.n,
      lastUsed: grants.last,
      saves14: saves,
      badRate: saves === 0 ? 0 : Math.round((bad / saves) * 100),
      reads24: reads,
    };
  });
}

export function approvals(app: App) {
  return prepared(app.ctx.db, `SELECT r.id, r.command, r.user_code, r.created_at, coalesce(c.display_name, r.client_id) client FROM stepup_request r
      LEFT JOIN client_policy c ON c.client_id = r.client_id WHERE r.approved_at IS NULL AND r.denied_at IS NULL AND r.expires_at > ? ORDER BY r.created_at`)
    .all(iso(app.ctx.clock.now())) as { id: string; command: string; user_code: string; created_at: string; client: string }[];
}

export function sections(app: App) {
  const db = app.ctx.db;
  return {
    sections: prepared(db, `SELECT s.id, s.name, s.origin, s.approved, (SELECT count(*) FROM memory WHERE section_id = s.id AND status IN ('active','contested')) memories
      FROM section s WHERE s.status = 'active' ORDER BY s.sort_order, s.name`).all() as { id: string; name: string; origin: string; approved: number; memories: number }[],
    attributes: prepared(db, "SELECT a.name, a.cardinality, s.name section, a.origin FROM attribute a JOIN section s ON s.id = a.section_id ORDER BY a.name").all() as { name: string; cardinality: string; section: string; origin: string }[],
  };
}

export function repos(app: App) {
  return prepared(app.ctx.db, "SELECT repo_key, display_name, enabled, capture, enabled_at FROM repo ORDER BY display_name").all() as {
    repo_key: string; display_name: string; enabled: number; capture: number; enabled_at: string | null;
  }[];
}

export function exportsView(app: App) {
  const db = app.ctx.db;
  return {
    recipients: prepared(db, "SELECT id, label, fingerprint, created_at FROM export_recipient WHERE revoked_at IS NULL ORDER BY created_at").all() as { id: string; label: string; fingerprint: string; created_at: string }[],
    log: prepared(db, `SELECT l.at, l.kind, l.recipient_fingerprint, coalesce(c.display_name, l.client_id) client FROM export_log l
      LEFT JOIN client_policy c ON c.client_id = l.client_id ORDER BY l.at DESC LIMIT 50`).all() as { at: string; kind: string; recipient_fingerprint: string | null; client: string }[],
  };
}

export function spend(app: App) {
  return prepared(app.ctx.db, "SELECT day, purpose, round(usd, 4) usd, tokens_in, tokens_out FROM llm_spend ORDER BY day DESC, purpose LIMIT 60").all() as { day: string; purpose: string; usd: number; tokens_in: number; tokens_out: number }[];
}

export function sectionOptions(app: App) {
  return prepared(app.ctx.db, "SELECT id, name FROM section WHERE status = 'active' ORDER BY sort_order, name").all() as { id: string; name: string }[];
}
