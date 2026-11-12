// The profile (retrieval.md §7): the small, stable summary every client loads as standing context.
//
//   header · section map · owner preferences (confirmed) · pinned · key facts · pending notice
//
// Each block has its own budget and is cut at whole items. Order and ties are fixed, so the text is
// byte-stable for a given store state and its sha256 (the etag) changes only when the profile does.
// Only global, non-sensitive, active memories at T0–T2 qualify; Projects never do.

import { createHash } from "node:crypto";
import type { ProfileOutputT } from "@memory-anywhere/contracts/schemas/tools";
import type { RecallItemT } from "@memory-anywhere/contracts/schemas/common";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfigT } from "../config/schema.ts";
import { POLICY_VERSION, TEXTS } from "../policy/generated.ts";
import { prepared } from "../store/db.ts";
import { SECTION } from "../write/resolve.ts";
import { contestPartnerIds, loadItem, toRecallItem, type ItemRow } from "./items.ts";
import { visible, type ReadPolicy, type Reader } from "./reader.ts";
import { newlySensitive } from "./render-check.ts";
import { codePointLength, escapeText, FRAMING, memoryLine } from "./render.ts";

export const PROFILE_MAX = 6000;

const BUDGET = { header: 600, sections: 400, preferences: 1800, pinned: 1000, keyFacts: 1800, pending: 200 } as const;
const HEADING = { preferences: "## Owner preferences (confirmed)", pinned: "## Pinned", keyFacts: "## Key facts" } as const;

export interface Profile {
  readonly output: ProfileOutputT;
  /** Memory ids shown, for the read ledger of session-start. */
  readonly memoryIds: readonly string[];
  /** Memories withheld by the render-time recheck. */
  readonly renderHits: readonly string[];
}

/** Takes whole lines until the budget is reached. */
function fit(lines: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const n = codePointLength(line) + (out.length > 0 ? 1 : 0);
    if (used + n > budget) break;
    out.push(line);
    used += n;
  }
  return out;
}

/** Current versions of global, unexpired, non-Projects memories with these statuses. */
function profileRows(db: DatabaseSync, nowIso: string): ItemRow[] {
  const ids = prepared(
    db,
    `SELECT v.id FROM memory m JOIN memory_version v ON v.memory_id = m.id
      WHERE v.valid_to IS NULL AND v.expired_at IS NULL AND v.content IS NOT NULL
        AND m.status IN ('active','contested') AND m.scope = 'global' AND m.sensitivity_category IS NULL
        AND m.section_id != ? AND v.trust_tier <= 2 AND NOT (m.kind = 'event' AND m.expires_at IS NOT NULL AND m.expires_at <= ?)
      ORDER BY m.id`,
  ).all(SECTION.projects, nowIso) as { id: string }[];
  return ids.map((r) => loadItem(db, r.id)).filter((r): r is ItemRow => r !== undefined);
}

const byRecorded = (a: ItemRow, b: ItemRow): number => a.recordedAt.localeCompare(b.recordedAt) || a.memoryId.localeCompare(b.memoryId);
const byAttribute = (a: ItemRow, b: ItemRow): number => (a.attributeSort ?? 1e9) - (b.attributeSort ?? 1e9) || byRecorded(a, b);

export function buildProfile(db: DatabaseSync, config: ServerConfigT, reader: Reader, policy: ReadPolicy, nowIso: string): Profile {
  const renderHits: string[] = [];
  const shown = (row: ItemRow): boolean => {
    if (!visible(reader, policy, ["global"], row, undefined)) return false;
    if (newlySensitive(row.content, row.sensitivity, config.sensitive.blocked)) {
      renderHits.push(row.memoryId);
      return false;
    }
    return true;
  };
  const rows = policy.profileEligible ? profileRows(db, nowIso).filter(shown) : [];
  const used = new Set<string>();
  const take = (picked: ItemRow[]): ItemRow[] => picked.filter((r) => !used.has(r.memoryId));

  // 3. Owner preferences (confirmed): T0 by attribute then time, then T1 by time.
  const prefRows = rows.filter((r) => r.status === "active" && r.tier <= 1 && (r.kind === "preference" || (r.kind === "instruction" && r.tier === 0)));
  const preferences = blockOf(take([...prefRows.filter((r) => r.tier === 0).sort(byAttribute), ...prefRows.filter((r) => r.tier === 1).sort(byRecorded)]),
    HEADING.preferences, BUDGET.preferences, used);

  // 4. Pinned (pinning is owner-only).
  const pinned = blockOf(take(rows.filter((r) => r.status === "active" && r.pinned).sort(byRecorded)), HEADING.pinned, BUDGET.pinned, used);

  // 5. Key facts: profile-key attributes; a contested `one` slot is one line naming both values.
  const keyFacts = keyFactsBlock(db, take(rows.filter((r) => r.profileKey).sort(byAttribute)), used, shown);

  // 2 and 6. Section map and pending notice.
  const sectionNames = (prepared(db, "SELECT name FROM section WHERE status = 'active' ORDER BY sort_order, id").all() as { name: string }[]).map((s) => s.name);
  const sectionLine = fit([`Sections: ${sectionNames.map(escapeText).join(", ")}`], BUDGET.sections);
  const reviews = prepared(db, "SELECT count(*) AS n FROM review_item WHERE resolved_at IS NULL AND kind != 'preference_confirm'").get() as { n: number };
  const confirms = prepared(db, "SELECT count(*) AS n FROM review_item WHERE resolved_at IS NULL AND kind = 'preference_confirm'").get() as { n: number };
  const pending = fit([
    ...(reviews.n > 0 ? [`${reviews.n} items await your review in the admin UI.`] : []),
    ...(confirms.n > 0 ? [`${confirms.n} stated preferences await confirmation.`] : []),
  ], BUDGET.pending);

  const text = [
    ...fit([TEXTS["profile-header"]], BUDGET.header),
    ...sectionLine,
    ...preferences.lines,
    ...pinned.lines,
    ...keyFacts.lines,
    ...pending,
  ].join("\n");
  return {
    output: {
      notice: FRAMING,
      policy_version: POLICY_VERSION,
      profile_etag: createHash("sha256").update(text, "utf8").digest("hex"),
      text,
      sections: sectionNames,
      owner_preferences: preferences.items,
      pinned: pinned.items,
      key_facts: keyFacts.items,
      pending_review_count: reviews.n,
    },
    memoryIds: [...used],
    renderHits,
  };
}

interface Block {
  readonly lines: string[];
  readonly items: RecallItemT[];
}

function blockOf(rows: readonly ItemRow[], heading: string, budget: number, used: Set<string>): Block {
  const candidates = rows.map((r) => ({ row: r, item: toRecallItem(r, []) }));
  const lines = fit([heading, ...candidates.map((c) => memoryLine(c.item))], budget);
  if (lines.length <= 1) return { lines: [], items: [] };
  const kept = candidates.slice(0, lines.length - 1);
  for (const c of kept) used.add(c.row.memoryId);
  return { lines, items: kept.map((c) => c.item) };
}

function keyFactsBlock(db: DatabaseSync, rows: readonly ItemRow[], used: Set<string>, shown: (r: ItemRow) => boolean): Block {
  const entries: { line: string; items: RecallItemT[]; ids: string[] }[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    if (done.has(r.memoryId)) continue;
    done.add(r.memoryId);
    if (r.status !== "contested") {
      entries.push({ line: memoryLine(toRecallItem(r, [])), items: [toRecallItem(r, [])], ids: [r.memoryId] });
      continue;
    }
    if (r.cardinality !== "one") continue; // only a contested `one` slot appears, as one line
    const partner = contestPartnerIds(db, r.memoryId)
      .map((id) => rows.find((x) => x.memoryId === id))
      .find((x): x is ItemRow => x !== undefined && shown(x));
    if (!partner) continue;
    done.add(partner.memoryId);
    const [a, b] = [r, partner].sort((x, y) => x.memoryId.localeCompare(y.memoryId)) as [ItemRow, ItemRow];
    entries.push({
      line: `- ${escapeText(a.attributeName ?? "")}: unconfirmed: ${escapeText(a.content)} [${a.memoryId}] / ${escapeText(b.content)} [${b.memoryId}] (ask the user)`,
      items: [toRecallItem(a, [b.memoryId]), toRecallItem(b, [a.memoryId])],
      ids: [a.memoryId, b.memoryId],
    });
  }
  const lines = fit([HEADING.keyFacts, ...entries.map((e) => e.line)], BUDGET.keyFacts);
  if (lines.length <= 1) return { lines: [], items: [] };
  const kept = entries.slice(0, lines.length - 1);
  for (const e of kept) for (const id of e.ids) used.add(id);
  return { lines, items: kept.flatMap((e) => e.items) };
}
