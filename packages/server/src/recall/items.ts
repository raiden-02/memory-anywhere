// One memory version with everything the read path needs to filter and render it, loaded by
// version id; and its conversion to the RecallItem shape of mcp-interface.md §2.

import type { DatabaseSync } from "node:sqlite";
import type { RecallItemT } from "@memory-anywhere/contracts/schemas/common";
import { prepared } from "../store/db.ts";
import type { SensitiveCategory } from "../policy/generated.ts";
import { tierLabel, type TierNum } from "../write/types.ts";
import type { Visibility } from "./reader.ts";

export interface ItemRow extends Visibility {
  readonly versionId: string;
  readonly memoryId: string;
  readonly content: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly expired: boolean;
  readonly recordedAt: string;
  readonly tier: TierNum;
  /** The memory's current version. */
  readonly current: boolean;
  readonly kind: RecallItemT["kind"];
  readonly status: string;
  readonly pinned: boolean;
  readonly expiresAt: string | null;
  readonly sectionName: string;
  readonly sectionSort: number;
  readonly attributeName: string | null;
  readonly attributeSort: number | null;
  readonly profileKey: boolean;
  readonly cardinality: "one" | "many" | null;
  readonly entityName: string;
  /** Display name of the client of the first source. */
  readonly via: string;
}

const SQL = `
SELECT v.id AS version_id, v.memory_id, v.content, v.valid_from, v.valid_to, v.expired_at IS NOT NULL AS expired, v.recorded_at, v.trust_tier,
       (v.valid_to IS NULL AND v.expired_at IS NULL) AS current,
       m.kind, m.scope, m.status, m.pinned, m.sensitivity_category, m.expires_at, m.section_id, m.entity_id,
       s.name AS section_name, s.sort_order AS section_sort,
       a.name AS attribute_name, a.sort_order AS attribute_sort, coalesce(a.restricted, 0) AS restricted, coalesce(a.profile_key, 0) AS profile_key, a.cardinality,
       e.type AS entity_type, e.canonical_name AS entity_name,
       (SELECT coalesce(cp.display_name, src.client_id) FROM memory_source ms
          JOIN source src ON src.id = ms.source_id LEFT JOIN client_policy cp ON cp.client_id = src.client_id
         WHERE ms.memory_id = m.id ORDER BY ms.observed_at, ms.id LIMIT 1) AS via
FROM memory_version v
JOIN memory m ON m.id = v.memory_id
JOIN section s ON s.id = m.section_id
JOIN entity e ON e.id = m.entity_id
LEFT JOIN attribute a ON a.id = m.attribute_id
WHERE v.id = ? AND v.content IS NOT NULL`;

interface Raw {
  version_id: string; memory_id: string; content: string; valid_from: string | null; valid_to: string | null; expired: number; recorded_at: string;
  trust_tier: TierNum; current: number; kind: RecallItemT["kind"]; scope: string; status: string; pinned: number; sensitivity_category: SensitiveCategory | null;
  expires_at: string | null; section_id: string; entity_id: string; section_name: string; section_sort: number; attribute_name: string | null;
  attribute_sort: number | null; restricted: number; profile_key: number; cardinality: "one" | "many" | null; entity_type: string; entity_name: string; via: string | null;
}

export function loadItem(db: DatabaseSync, versionId: string): ItemRow | undefined {
  const r = prepared(db, SQL).get(versionId) as Raw | undefined;
  if (!r) return undefined;
  return {
    versionId: r.version_id, memoryId: r.memory_id, content: r.content, validFrom: r.valid_from, validTo: r.valid_to, expired: r.expired === 1,
    recordedAt: r.recorded_at, tier: r.trust_tier, current: r.current === 1, kind: r.kind, scope: r.scope, status: r.status, pinned: r.pinned === 1,
    sensitivity: r.sensitivity_category, expiresAt: r.expires_at, sectionId: r.section_id, entityId: r.entity_id, sectionName: r.section_name,
    sectionSort: r.section_sort, attributeName: r.attribute_name, attributeSort: r.attribute_sort, restricted: r.restricted === 1,
    profileKey: r.profile_key === 1, cardinality: r.cardinality, entityType: r.entity_type, entityName: r.entity_name, via: r.via ?? "unknown",
  };
}

/** The memory's current version, if it has one. */
export function loadCurrent(db: DatabaseSync, memoryId: string): ItemRow | undefined {
  const v = prepared(db, "SELECT id FROM memory_version WHERE memory_id = ? AND valid_to IS NULL AND expired_at IS NULL").get(memoryId) as { id: string } | undefined;
  return v ? loadItem(db, v.id) : undefined;
}

/** Unresolved contest partners of a memory. */
export function contestPartnerIds(db: DatabaseSync, memoryId: string): string[] {
  return (prepared(db, "SELECT other_memory_id FROM memory_contest WHERE memory_id = ? AND resolved_at IS NULL ORDER BY other_memory_id").all(memoryId) as {
    other_memory_id: string;
  }[]).map((r) => r.other_memory_id);
}

export function toRecallItem(row: ItemRow, contestedWith: readonly string[]): RecallItemT {
  const status = !row.current || row.status === "superseded" ? "superseded" : row.status === "contested" ? "contested" : "active";
  return {
    id: row.memoryId as RecallItemT["id"],
    kind: row.kind,
    entity: row.entityName,
    section: row.sectionName,
    attribute: row.attributeName,
    content: row.content,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    recorded_at: row.recordedAt,
    tier: tierLabel(row.tier),
    status,
    ...(status === "contested" && contestedWith.length > 0 ? { contested_with: [...contestedWith] as RecallItemT["id"][] } : {}),
    via: row.via,
    expires_at: row.expiresAt,
  };
}
