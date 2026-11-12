// The owner's CLI commands (config-and-cli.md §4.2; memory-policy.md §10). In local mode they arrive
// at `/v1/admin/<command>` with the local token, which is the owner credential (topology-and-ipc.md
// §4); in aws mode the same functions run behind a step-up token (M2). Owner writes are T0 and go
// through the normal write path on the `admin` channel.

import { normEntity } from "@memory-anywhere/contracts/normalize";
import type { z } from "zod";
import type { ProjectAddArgs, ProjectTrackArgs, RepoDisableArgs, RepoEnableArgs, ReviewArgs } from "@memory-anywhere/contracts/schemas/v1";
import { iso } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { LOCAL_CLIENT_ID } from "../store/init.ts";
import { save, type WriteEnv } from "../write/pipeline.ts";
import { resolveReviews } from "../write/review.ts";
import { ensureEntity } from "../write/rows.ts";
import { SECTION } from "../write/resolve.ts";
import { WriteError, type Caller, type SaveRequest } from "../write/types.ts";

const OWNER: Caller = {
  clientId: LOCAL_CLIENT_ID, clientClass: "coding", channel: "admin", tier: 0, sessionKey: "admin", repoKey: undefined, tool: undefined,
  floored: false, canElicit: false, elicitationAnswer: undefined,
};

const ownerSave = async (env: WriteEnv, req: Omit<SaveRequest, "why_durable" | "explicit_request" | "scope" | "change">): Promise<string | undefined> => {
  const r = await save(env, OWNER, { why_durable: "set by the owner", explicit_request: true, scope: "global", change: "update", ...req }, {
    idempotencyKey: env.ctx.ids.newId("adm", env.ctx.clock.now()),
    observedAt: env.ctx.clock.now(),
  });
  return r.kind === "result" ? r.outcome.id : undefined;
};

/** `mema enable`: the repo is enabled (and optionally tracked as a project). */
export async function repoEnable(env: WriteEnv, args: z.infer<typeof RepoEnableArgs>): Promise<{ repo_key: string; enabled: true; project_entity_id: string | null }> {
  const { db, clock } = env.ctx;
  transaction(db, () => {
    prepared(db, `INSERT INTO repo (repo_key, display_name, enabled, capture, enabled_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(repo_key) DO UPDATE SET display_name = excluded.display_name, enabled = 1, capture = excluded.capture, enabled_at = excluded.enabled_at, disabled_at = NULL`)
      .run(args.repo_key, args.display_name, args.capture ? 1 : 0, iso(clock.now()));
    appendEvent(env.ctx, { actor: "owner", op: "repo.enable", refs: { repo_key: args.repo_key, capture: args.capture } });
  });
  const tracked = args.track ? await projectTrack(env, { repo_key: args.repo_key, name: args.track.name, repo_url: args.track.repo_url }) : undefined;
  const row = prepared(db, "SELECT project_entity_id FROM repo WHERE repo_key = ?").get(args.repo_key) as { project_entity_id: string | null };
  env.onCommit?.([]);
  return { repo_key: args.repo_key, enabled: true, project_entity_id: tracked?.project_entity_id ?? row.project_entity_id };
}

/** `mema disable`. */
export function repoDisable(env: WriteEnv, args: z.infer<typeof RepoDisableArgs>): { repo_key: string; enabled: false } {
  const { db, clock } = env.ctx;
  transaction(db, () => {
    const r = prepared(db, "UPDATE repo SET enabled = 0, capture = 0, disabled_at = ? WHERE repo_key = ?").run(iso(clock.now()), args.repo_key);
    if (r.changes === 0) throw new WriteError("NOT_FOUND", "this repository was never enabled", "repo_key");
    appendEvent(env.ctx, { actor: "owner", op: "repo.disable", refs: { repo_key: args.repo_key } });
  });
  env.onCommit?.([]);
  return { repo_key: args.repo_key, enabled: false };
}

/** An approved project entity for this name (found by its aliases, or created). */
function projectEntity(env: WriteEnv, name: string): string {
  const existing = prepared(env.ctx.db, "SELECT e.id FROM entity_alias a JOIN entity e ON e.id = a.entity_id WHERE a.alias_norm = ? AND a.approved = 1 AND e.type = 'project' AND e.status = 'active' ORDER BY e.created_at LIMIT 1")
    .get(normEntity(name)) as { id: string } | undefined;
  if (existing) {
    prepared(env.ctx.db, "UPDATE entity SET approved = 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  return ensureEntity(env.ctx, OWNER, {
    entity: { name, type: "project", isNew: true }, attribute: undefined, slotFromLlm: false, sectionId: SECTION.projects, isPeopleSection: false, tasteClass: false,
  }, 0).id;
}

/** `mema project track`: an approved project for the current repo, with project.repo and status active, linked to the repo. */
export async function projectTrack(env: WriteEnv, args: z.infer<typeof ProjectTrackArgs>): Promise<{ project_entity_id: string }> {
  const { db } = env.ctx;
  const repo = prepared(db, "SELECT enabled FROM repo WHERE repo_key = ?").get(args.repo_key) as { enabled: number } | undefined;
  if (repo?.enabled !== 1) throw new WriteError("REPO_NOT_ENABLED", "Run `mema enable` in this repository first.", "repo_key");
  const entityId = transaction(db, () => projectEntity(env, args.name));
  await ownerSave(env, { content: "Status: active", kind: "fact", entity: args.name, attribute: "project.status" });
  if (args.repo_url) await ownerSave(env, { content: `Repository: ${args.repo_url}`, kind: "fact", entity: args.name, attribute: "project.repo" });
  transaction(db, () => {
    prepared(db, "UPDATE repo SET project_entity_id = ? WHERE repo_key = ?").run(entityId, args.repo_key);
    appendEvent(env.ctx, { actor: "owner", op: "project.track", refs: { repo_key: args.repo_key, entity_id: entityId } });
  });
  env.onCommit?.([]);
  return { project_entity_id: entityId };
}

/** `mema project add`: an approved project with no repository. */
export async function projectAdd(env: WriteEnv, args: z.infer<typeof ProjectAddArgs>): Promise<{ project_entity_id: string }> {
  const { db, clock } = env.ctx;
  const entityId = transaction(db, () => {
    const id = projectEntity(env, args.name);
    const alias = prepared(db, "INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, origin, approved, created_at) VALUES (?, ?, 'owner', 1, ?)");
    for (const a of args.aliases) alias.run(normEntity(a), id, iso(clock.now()));
    return id;
  });
  if (args.status) await ownerSave(env, { content: `Status: ${args.status}`, kind: "fact", entity: args.name, attribute: "project.status" });
  if (args.goal) await ownerSave(env, { content: args.goal, kind: "fact", entity: args.name, attribute: "project.goal" });
  env.onCommit?.([]);
  return { project_entity_id: entityId };
}

/** `mema review`: without decisions, the open items (ids, kinds and ages only); otherwise resolves them. */
export function review(env: WriteEnv, args: z.infer<typeof ReviewArgs>): { resolved: number; pending: { id: string; kind: string; created_at: string }[] } {
  const decisions = [...args.approve.map((id) => ({ id, resolution: "approved" as const })), ...args.reject.map((id) => ({ id, resolution: "rejected" as const }))];
  const touched = decisions.length > 0 ? resolveReviews(env.ctx, decisions, env.config.retention.forgotten_purge_days) : [];
  if (decisions.length > 0) env.onCommit?.(touched);
  const pending = prepared(env.ctx.db, "SELECT id, kind, created_at FROM review_item WHERE resolved_at IS NULL ORDER BY created_at, id").all() as {
    id: string; kind: string; created_at: string;
  }[];
  return { resolved: decisions.length, pending };
}
