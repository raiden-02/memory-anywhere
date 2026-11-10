// Session-start context for coding tools (retrieval.md §8): what a new Claude Code, Codex or
// Cursor session in an enabled repo is told before the first prompt.
//
//   preamble · profile · project card · project decisions · repo notes · one-time notices
//
// Claude Code gets 9,000 characters; Codex and Cursor 6,000, with every block budget scaled by
// 6/9. The result is cached per (client, repo, tool) and dropped on any commit, so a warm call does
// no embedding, no FTS and no rendering.

import type { DatabaseSync } from "node:sqlite";
import type { SessionStartResponseT } from "@memory-anywhere/contracts/schemas/v1";
import type { ServerConfigT } from "../config/schema.ts";
import { POLICY_VERSION, TEXTS } from "../policy/generated.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { loadItem, toRecallItem, type ItemRow } from "./items.ts";
import { buildProfile } from "./profile.ts";
import { readPolicy, recordReads, visible, type ReadPolicy, type Reader } from "./reader.ts";
import { flagRenderSensitive, newlySensitive } from "./render-check.ts";
import { codePointLength, escapeText, memoryLine } from "./render.ts";

export type CodingTool = "claude-code" | "codex" | "cursor";

export const NOT_ENABLED_CONTEXT = "memory-anywhere is available but not enabled for this repository. The user can enable it with: mema enable";
export const UNTRACKED_NOTICE = "This repo is not tracked as a project. If the user wants that, they can run `mema project track`.";
const MAX_IDS = 40;
const FULL = 9000;
const TOOL_TARGET: Readonly<Record<CodingTool, number>> = { "claude-code": 9000, codex: 6000, cursor: 6000 };
const BLOCK = { preamble: 400, profile: 4500, card: 800, decisions: 2000, repo: 1000, notices: 300 } as const;
const CARD_FIELDS = ["project.status", "project.goal", "project.role", "project.stack"] as const;

export interface SessionStartEnv {
  readonly ctx: StoreContext;
  readonly config: ServerConfigT;
}

export interface SessionStartResult {
  readonly response: SessionStartResponseT;
  /** Ledger rows and one-time notice flags; run after the response is sent. */
  record(): void;
}

interface Built {
  readonly response: SessionStartResponseT;
  readonly memoryIds: readonly string[];
  readonly renderHits: readonly string[];
  readonly untrackedShown: boolean;
  /** The repo's linked project, whose activity each session records. */
  readonly projectEntityId: string | null;
}

/** Cached session-start contexts, emptied after every commit (WriteEnv.onCommit). */
export class SessionStartCache {
  readonly #entries = new Map<string, Built>();

  invalidate(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  sessionStart(env: SessionStartEnv, reader: Reader, tool: CodingTool, maxChars: number, extraNotices: readonly string[] = []): SessionStartResult {
    const key = JSON.stringify([reader.clientId, reader.repoKey ?? "none", tool, maxChars, extraNotices]);
    let built = this.#entries.get(key);
    if (!built) {
      built = build(env, reader, tool, maxChars, extraNotices);
      this.#entries.set(key, built);
    }
    const b = built;
    return {
      response: b.response,
      record: () => {
        const { ctx } = env;
        transaction(ctx.db, () => {
          recordReads(ctx.db, reader.clientId, b.memoryIds, ctx.clock.now(), false);
          flagRenderSensitive(ctx, reader, b.renderHits);
          if (b.untrackedShown && reader.repoKey) prepared(ctx.db, "UPDATE repo SET untracked_prompted = 1 WHERE repo_key = ?").run(reader.repoKey);
          // memory-policy.md §10 "Ongoing": a session in the repo counts as activity on its project.
          if (b.projectEntityId) {
            prepared(ctx.db, `INSERT INTO entity_activity (entity_id, last_activity_at, last_client_id, session_count) VALUES (?, ?, ?, 1)
              ON CONFLICT(entity_id) DO UPDATE SET last_activity_at = excluded.last_activity_at, last_client_id = excluded.last_client_id, session_count = session_count + 1`)
              .run(b.projectEntityId, iso(ctx.clock.now()), reader.clientId);
          }
        });
        // The one-time notice is now spent, so the next session must not reuse this context.
        if (b.untrackedShown) this.invalidate();
      },
    };
  }
}

/** Whole lines until the budget; memory lines past the id cap are skipped. */
function fit(lines: readonly { text: string; ids: readonly string[] }[], budget: number, ids: Set<string>): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const n = codePointLength(l.text) + 1;
    if (used + n > budget) break;
    const fresh = l.ids.filter((id) => !ids.has(id));
    if (ids.size + fresh.length > MAX_IDS) continue;
    for (const id of fresh) ids.add(id);
    out.push(l.text);
    used += n;
  }
  return out;
}

const plain = (text: string): { text: string; ids: readonly string[] } => ({ text, ids: [] });
const memory = (row: ItemRow): { text: string; ids: readonly string[] } => ({ text: memoryLine(toRecallItem(row, [])), ids: [row.memoryId] });

function build(env: SessionStartEnv, reader: Reader, tool: CodingTool, maxChars: number, extraNotices: readonly string[]): Built {
  const { ctx, config } = env;
  const { db } = ctx;
  const now = iso(ctx.clock.now());
  const policy = readPolicy(db, reader);
  const profile = buildProfile(db, config, reader, policy, now);
  const base = {
    profile_etag: profile.output.profile_etag,
    profile: profile.output.text,
    policy_version: POLICY_VERSION,
  };
  if (!policy.repo) {
    const context = NOT_ENABLED_CONTEXT;
    return { response: { ...base, context, repo_enabled: false, capture_enabled: false, notices: [...extraNotices] }, memoryIds: [], renderHits: [], untrackedShown: false, projectEntityId: null };
  }

  const total = Math.min(TOOL_TARGET[tool], maxChars);
  const scale = (n: number): number => Math.floor((n * total) / FULL);
  const ids = new Set<string>();
  const renderHits: string[] = [...profile.renderHits];
  const shown = (row: ItemRow): boolean => {
    if (!visible(reader, policy, ["global", `repo:${policy.repo?.key}`], row, undefined)) return false;
    if (newlySensitive(row.content, row.sensitivity, config.sensitive.blocked)) {
      renderHits.push(row.memoryId);
      return false;
    }
    return true;
  };

  // 1–2. Preamble and profile (cut at whole lines; profile lines keep their ids).
  // The preamble is fixed policy text that frames everything after it as data; it never shrinks
  // with the target (spec-issues #43). Only the memory blocks scale.
  const preamble = fit([plain(TEXTS["session-preamble"])], BLOCK.preamble, ids);
  const profileIds = new Set(profile.memoryIds);
  const profileLines = fit(profile.output.text.split("\n").map((text) => ({ text, ids: [...text.matchAll(/\[(mem_[0-9A-Z]{26})\]/gu)].map((m) => m[1] as string).filter((id) => profileIds.has(id)) })),
    scale(BLOCK.profile), ids);

  // 3–4. The linked project's card and its decisions and constraints.
  const projectId = policy.repo.projectEntityId;
  const projectRows = projectId ? projectMemories(db, projectId).filter(shown) : [];
  const projectName = projectId ? (prepared(db, "SELECT canonical_name FROM entity WHERE id = ? AND approved = 1").get(projectId) as { canonical_name: string } | undefined) : undefined;
  const card = projectName
    ? fit([plain("## Project"), plain(`Name: ${escapeText(projectName.canonical_name)}`),
      ...CARD_FIELDS.flatMap((f) => projectRows.filter((r) => r.attributeName === f).sort(newestFirst).map(memory))], scale(BLOCK.card), ids)
    : [];
  const decisionRows = projectName ? projectRows.filter((r) => r.attributeName === "project.decision" || r.attributeName === "project.constraint").sort(newestFirst) : [];
  const decisions = decisionRows.length > 0 ? fit([plain("## Project decisions"), ...decisionRows.map(memory)], scale(BLOCK.decisions), ids) : [];

  // 5. Repo-scoped memories.
  const repoRows = repoMemories(db, policy, now).filter(shown);
  const repoNotes = repoRows.length > 0 ? fit([plain("## Repo notes"), ...repoRows.map(memory)], scale(BLOCK.repo), ids) : [];

  // 6. One-time notices.
  const untracked = !projectId && (prepared(db, "SELECT untracked_prompted FROM repo WHERE repo_key = ?").get(policy.repo.key) as { untracked_prompted: number }).untracked_prompted === 0;
  const reviewCount = profile.output.pending_review_count;
  const noticeTexts = [...(untracked ? [UNTRACKED_NOTICE] : []), ...(reviewCount > 0 ? [`${reviewCount} items await your review in the admin UI.`] : []), ...extraNotices];
  // The profile already carries the pending-review line when it fits; it is not repeated.
  const notices = fit(noticeTexts.filter((n) => !profileLines.includes(n)).map(plain), scale(BLOCK.notices), ids);

  const context = [...preamble, ...profileLines, ...card, ...dropLoneHeading(decisions), ...dropLoneHeading(repoNotes), ...notices].join("\n");
  return {
    response: { ...base, context, repo_enabled: true, capture_enabled: policy.repo.capture, notices: noticeTexts },
    memoryIds: [...ids],
    renderHits,
    untrackedShown: untracked && notices.includes(UNTRACKED_NOTICE),
    projectEntityId: projectName ? projectId : null,
  };
}

const dropLoneHeading = (lines: string[]): string[] => (lines.length <= 1 ? [] : lines);

/** Newest first by valid_from, then recorded_at (retrieval.md §8 block 4). */
const newestFirst = (a: ItemRow, b: ItemRow): number =>
  (b.validFrom ?? "").localeCompare(a.validFrom ?? "") || b.recordedAt.localeCompare(a.recordedAt) || a.memoryId.localeCompare(b.memoryId);

function currentRows(db: DatabaseSync, where: string, ...params: string[]): ItemRow[] {
  const ids = prepared(db, `SELECT v.id FROM memory m JOIN memory_version v ON v.memory_id = m.id
    WHERE v.valid_to IS NULL AND v.expired_at IS NULL AND v.content IS NOT NULL AND m.status IN ('active','contested') AND m.sensitivity_category IS NULL AND ${where}
    ORDER BY m.id`).all(...params) as { id: string }[];
  return ids.map((r) => loadItem(db, r.id)).filter((r): r is ItemRow => r !== undefined);
}

const projectMemories = (db: DatabaseSync, entityId: string): ItemRow[] => currentRows(db, "m.entity_id = ?", entityId);

function repoMemories(db: DatabaseSync, policy: ReadPolicy, nowIso: string): ItemRow[] {
  return currentRows(db, "m.scope = ? AND NOT (m.kind = 'event' AND m.expires_at IS NOT NULL AND m.expires_at <= ?)", `repo:${policy.repo?.key}`, nowIso)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.memoryId.localeCompare(b.memoryId));
}
