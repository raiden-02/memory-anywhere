// Who is reading, and what they may see (retrieval.md §2 step 5, §4, §5): the caller's client
// policy, its visible scopes, the shared hard filters, and the read budget kept in `read_ledger`.

import type { DatabaseSync } from "node:sqlite";
import { HOUR_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import type { SensitiveCategory } from "../policy/generated.ts";
import type { ClientClass } from "../write/types.ts";

export interface Reader {
  readonly clientId: string;
  readonly clientClass: ClientClass;
  /** Coding callers: the repo the call came from (`none` outside a repo). */
  readonly repoKey: string | undefined;
  /** The owner's admin session: sees restricted attributes. */
  readonly admin: boolean;
}

export interface ReadPolicy {
  readonly read: boolean;
  readonly displayName: string;
  readonly sectionAllow: ReadonlySet<string> | "all";
  readonly sensitiveAllow: ReadonlySet<SensitiveCategory>;
  readonly profileEligible: boolean;
  readonly budget1h: number;
  readonly budget24h: number;
  /** The enabled repo the caller is in, or undefined. */
  readonly repo: { readonly key: string; readonly projectEntityId: string | null; readonly capture: boolean } | undefined;
}

interface PolicyRow {
  read: number;
  display_name: string;
  section_allow_json: string;
  sensitive_allow_json: string;
  profile_eligible: number;
  read_budget_1h: number;
  read_budget_24h: number;
}

export function readPolicy(db: DatabaseSync, reader: Reader): ReadPolicy {
  const p = prepared(db, "SELECT read, display_name, section_allow_json, sensitive_allow_json, profile_eligible, read_budget_1h, read_budget_24h FROM client_policy WHERE client_id = ? AND revoked_at IS NULL")
    .get(reader.clientId) as PolicyRow | undefined;
  const repoRow = reader.repoKey && reader.repoKey !== "none"
    ? (prepared(db, "SELECT repo_key, enabled, capture, project_entity_id FROM repo WHERE repo_key = ?").get(reader.repoKey) as
        | { repo_key: string; enabled: number; capture: number; project_entity_id: string | null }
        | undefined)
    : undefined;
  const allow = p ? (JSON.parse(p.section_allow_json) as string[]) : [];
  return {
    read: p?.read === 1,
    displayName: p?.display_name ?? reader.clientId,
    sectionAllow: allow.includes("*") ? "all" : new Set(allow),
    sensitiveAllow: new Set(p ? (JSON.parse(p.sensitive_allow_json) as SensitiveCategory[]) : []),
    profileEligible: p?.profile_eligible === 1,
    budget1h: p?.read_budget_1h ?? 0,
    budget24h: p?.read_budget_24h ?? 0,
    repo: repoRow?.enabled === 1 ? { key: repoRow.repo_key, projectEntityId: repoRow.project_entity_id, capture: repoRow.capture === 1 } : undefined,
  };
}

/** Coding callers read only inside an enabled repo (mcp-interface.md §5). */
export const repoBlocked = (reader: Reader, policy: ReadPolicy): boolean => reader.clientClass === "coding" && !reader.admin && policy.repo === undefined;

/** Visible scopes (retrieval.md §4), narrowed by the recall `scope` input. */
export function visibleScopes(policy: ReadPolicy, scope: "any" | "global" | "repo" = "any"): string[] {
  const repo = policy.repo ? [`repo:${policy.repo.key}`] : [];
  if (scope === "global") return ["global"];
  if (scope === "repo") return repo;
  return ["global", ...repo];
}

/** The facts about a memory that the hard filters look at. */
export interface Visibility {
  readonly scope: string;
  readonly sectionId: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly restricted: boolean;
  readonly sensitivity: SensitiveCategory | null;
}

/**
 * Hard filters 3–7 of retrieval.md §2 step 5: scope, section allow-list, the projects rule,
 * restricted attributes, and sensitivity. `mentions` says whether the query names a category
 * (recall only; the profile and session-start never show a sensitive memory).
 */
export function visible(
  reader: Reader, policy: ReadPolicy, scopes: readonly string[], v: Visibility, mentions: ((c: SensitiveCategory) => boolean) | undefined,
): boolean {
  if (!scopes.includes(v.scope)) return false;
  if (policy.sectionAllow !== "all" && !policy.sectionAllow.has(v.sectionId)) return false;
  if (reader.clientClass === "coding" && !reader.admin && v.entityType === "project" && v.entityId !== policy.repo?.projectEntityId) return false;
  if (v.restricted && !reader.admin) return false;
  if (v.sensitivity !== null) return mentions !== undefined && policy.sensitiveAllow.has(v.sensitivity) && mentions(v.sensitivity);
  return true;
}

// ---- read budget (retrieval.md §5)

export interface Budget {
  /** Whether the next memory can be returned; counts it if it can. */
  admit(memoryId: string): boolean;
}

/**
 * Distinct memory ids returned to this client in the rolling 1 h and 24 h windows. A memory
 * already read in a window costs nothing again in that window.
 */
export function readBudget(db: DatabaseSync, clientId: string, policy: ReadPolicy, nowMs: number): Budget {
  const since = (ms: number): Set<string> =>
    new Set((prepared(db, "SELECT DISTINCT memory_id FROM read_ledger WHERE client_id = ? AND first_read_at > ?").all(clientId, iso(nowMs - ms)) as {
      memory_id: string;
    }[]).map((r) => r.memory_id));
  const hour = since(HOUR_MS);
  const day = since(24 * HOUR_MS);
  return {
    admit(memoryId) {
      const addHour = hour.has(memoryId) ? 0 : 1;
      const addDay = day.has(memoryId) ? 0 : 1;
      if (hour.size + addHour > policy.budget1h || day.size + addDay > policy.budget24h) return false;
      hour.add(memoryId);
      day.add(memoryId);
      return true;
    },
  };
}

/**
 * Records returned memories: one ledger row per memory not already read in the last hour (so
 * both windows count it exactly once), plus the recall counters.
 */
export function recordReads(db: DatabaseSync, clientId: string, memoryIds: readonly string[], nowMs: number, counts: boolean): void {
  const now = iso(nowMs);
  const seen = prepared(db, "SELECT 1 FROM read_ledger WHERE client_id = ? AND memory_id = ? AND first_read_at > ? LIMIT 1");
  const insert = prepared(db, "INSERT OR IGNORE INTO read_ledger (client_id, memory_id, first_read_at) VALUES (?, ?, ?)");
  const bump = prepared(db, "UPDATE memory SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?");
  for (const id of new Set(memoryIds)) {
    if (!seen.get(clientId, id, iso(nowMs - HOUR_MS))) insert.run(clientId, id, now);
    if (counts) bump.run(now, id);
  }
}
