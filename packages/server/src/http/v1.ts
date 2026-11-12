// The internal API (mcp-interface.md §7) used by hooks, the spool and the CLI. Each handler takes
// the parsed JSON body and the caller's grant and returns a status and a body; the HTTP layer does
// transport, auth, limits and logging. Bodies are validated with the same zod schemas that the
// committed JSON Schemas are generated from.

import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ErrorCodeT, ErrorObjectT } from "@memory-anywhere/contracts/schemas/common";
import {
  ADMIN_ARGS, ForgetPayload, PromptPayload, SavePayload, ReposCheckRequest, RecallRequest, SessionStartRequest, WritesRequest, type EntryT, type WriteResultT,
} from "@memory-anywhere/contracts/schemas/v1";
import { projectAdd, projectTrack, repoDisable, repoEnable, review } from "../admin/commands.ts";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, SERVER_VERSION, type App } from "../app.ts";
import { POLICY_VERSION } from "../policy/generated.ts";
import { buildProfile } from "../recall/profile.ts";
import { readPolicy } from "../recall/reader.ts";
import { recall } from "../recall/recall.ts";
import type { CodingTool } from "../recall/session-start.ts";
import { prepared } from "../store/db.ts";
import { forget, save } from "../write/pipeline.ts";
import { intakePrompt } from "../write/prompt.ts";
import { WriteError, type Caller } from "../write/types.ts";
import type { Grant } from "../api/grant.ts";
import { status, writeCaller } from "../api/tools.ts";

export interface V1Response {
  readonly status: number;
  readonly body: unknown;
  /** Work after the response is written (ledger rows). */
  readonly after?: () => void;
  /** Codes for the log line. */
  readonly op?: string;
  readonly outcome?: string;
}

const HTTP_STATUS: Record<ErrorCodeT, number> = {
  INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, READ_ONLY_CLIENT: 403, REPO_NOT_ENABLED: 403, NOT_FOUND: 404,
  RATE_LIMITED: 429, STORE_UNAVAILABLE: 503, CLIENT_TOO_OLD: 426, INTERNAL: 500,
};

export function apiError(code: ErrorCodeT, message: string, extra: Partial<ErrorObjectT> = {}): V1Response {
  return { status: HTTP_STATUS[code], body: { code, message: message.slice(0, 300), ...extra }, outcome: code };
}

function invalid(error: z.ZodError): V1Response {
  const issue = error.issues[0];
  return apiError("INVALID_INPUT", issue?.message ?? "invalid request", { field: issue?.path.join(".") || "body" });
}

export function fromWriteError(e: unknown): V1Response {
  if (e instanceof WriteError) return apiError(e.code, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.retryAfterS ? { retry_after_s: e.retryAfterS } : {}) });
  if (e instanceof Error && /SQLITE_BUSY|database is locked/iu.test(e.message)) return apiError("STORE_UNAVAILABLE", "the store is busy; try again shortly");
  return apiError("INTERNAL", "internal error");
}

/** major.minor equal to the server's, or one minor below (topology-and-ipc.md §11). */
export function clientVersionOk(version: string | null): boolean {
  const m = /^(\d+)\.(\d+)\.\d+/u.exec(version ?? "");
  if (!m) return false;
  const [sMajor, sMinor] = SERVER_VERSION.split(".").map(Number) as [number, number];
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === sMajor && (minor === sMinor || minor === sMinor - 1);
}

export const tooOld = (): V1Response => ({
  status: 426,
  body: { code: "CLIENT_TOO_OLD", message: "this client is too old for the store", min_client_version: MIN_CLIENT_VERSION, upgrade: `npm i -g memory-anywhere@${SERVER_VERSION}` },
  outcome: "CLIENT_TOO_OLD",
});

export function health(app: App): V1Response {
  return { status: 200, body: { ok: app.healthy(), version: SERVER_VERSION, schema_version: SCHEMA_VERSION, policy_version: POLICY_VERSION, min_client_version: MIN_CLIENT_VERSION } };
}

const withRepo = (grant: Grant, repoKey: string): Grant => ({ ...grant, repoKey });

export function sessionStart(app: App, grant: Grant, body: unknown, notices: readonly string[]): V1Response {
  if (!grant.scopes.capture) return apiError("FORBIDDEN", "this grant cannot start sessions");
  const parsed = SessionStartRequest.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const req = parsed.data;
  const r = app.sessions.sessionStart({ ctx: app.ctx, config: app.config }, withRepo(grant, req.repo_key), req.tool as CodingTool, req.max_chars, notices);
  return { status: 200, body: r.response, after: r.record, op: "session-start", outcome: r.response.repo_enabled ? "context" : "not_enabled" };
}

/** Profile and repo context for the client's offline caches; not counted against read budgets. */
export function projection(app: App, grant: Grant, query: URLSearchParams): V1Response {
  if (!grant.scopes.capture) return apiError("FORBIDDEN", "this grant cannot read projections");
  const repoKey = query.get("repo_key") ?? "none";
  const reader = withRepo(grant, repoKey);
  const now = new Date(app.ctx.clock.now()).toISOString();
  const profile = buildProfile(app.ctx.db, app.config, reader, readPolicy(app.ctx.db, reader), now).output.text;
  const ctx = app.sessions.sessionStart({ ctx: app.ctx, config: app.config }, reader, "claude-code", 9000).response;
  const repoContext = ctx.repo_enabled ? ctx.context : null;
  const etag = createHash("sha256").update(`${profile}\u0000${repoContext ?? ""}`, "utf8").digest("hex");
  if (query.get("etag") === etag) return { status: 304, body: undefined, op: "projection", outcome: "not_modified" };
  return { status: 200, body: { profile, repo_context: repoContext, etag, generated_at: now }, op: "projection", outcome: "ok" };
}

export async function recallRoute(app: App, grant: Grant, body: unknown): Promise<V1Response> {
  if (!grant.scopes.read) return apiError("FORBIDDEN", "this grant cannot read");
  const parsed = RecallRequest.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const { repo_key, ...input } = parsed.data;
  const wait = app.limits.recall.take(grant.clientId);
  if (wait > 0) return apiError("RATE_LIMITED", "recall limit reached", { retry_after_s: wait });
  const r = await recall(app.read, withRepo(grant, repo_key), input);
  return { status: 200, body: r.output, after: r.record, op: "recall", outcome: r.output.items.length > 0 ? "items" : "empty" };
}

export function statusRoute(app: App, grant: Grant): V1Response {
  if (!grant.scopes.read) return apiError("FORBIDDEN", "this grant cannot read");
  return { status: 200, body: status(app, grant).structuredContent, op: "status", outcome: "ok" };
}

export function reposCheck(app: App, grant: Grant, body: unknown): V1Response {
  if (!grant.scopes.capture) return apiError("FORBIDDEN", "this grant cannot check repos");
  const parsed = ReposCheckRequest.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const row = prepared(app.ctx.db, "SELECT r.enabled, r.capture, e.canonical_name FROM repo r LEFT JOIN entity e ON e.id = r.project_entity_id AND e.approved = 1 WHERE r.repo_key = ?")
    .get(parsed.data.repo_key) as { enabled: number; capture: number; canonical_name: string | null } | undefined;
  return { status: 200, body: { enabled: row?.enabled === 1, capture: row?.enabled === 1 && row.capture === 1, project: row?.enabled === 1 ? row.canonical_name : null }, op: "repos-check", outcome: "ok" };
}

/** A forget entry older than this was spooled, and forgets are never accepted from the spool (§7). */
const FORGET_MAX_AGE_MS = 60_000;

export async function writes(app: App, grant: Grant, body: unknown): Promise<V1Response> {
  const parsed = WritesRequest.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  // Dry runs need the result shape of write-path.md §13, which arrives with imports (spec-issues #40).
  if (parsed.data.dry_run) return apiError("INVALID_INPUT", "dry_run is not available yet", { field: "dry_run" });
  const results: WriteResultT[] = [];
  for (const entry of parsed.data.entries) results.push(await writeEntry(app, grant, entry));
  return { status: 200, body: { results }, op: "writes", outcome: `${results.length}` };
}

async function writeEntry(app: App, grant: Grant, entry: EntryT): Promise<WriteResultT> {
  const key = entry.idempotency_key;
  const observedAt = Math.min(Date.parse(entry.observed_at), app.ctx.clock.now());
  const g: Grant = { ...grant, repoKey: entry.repo_key ?? grant.repoKey, tool: entry.tool ?? grant.tool, session: entry.session_id ?? grant.session };
  const rejected = (reason: string): WriteResultT => ({ idempotency_key: key, outcome: "rejected", reason });
  try {
    switch (entry.op) {
      case "prompt": {
        if (!g.scopes.capture) return rejected("FORBIDDEN");
        if (app.limits.prompt.take(g.clientId) > 0) return rejected("RATE_LIMITED");
        const p = PromptPayload.safeParse(entry.payload);
        if (!p.success) return rejected("INVALID_INPUT");
        const caller: Caller = { ...writeCaller(app, g), channel: "spool_save" };
        return intakePrompt(app.write, caller, key, p.data.prompt, g.session, observedAt);
      }
      case "save": {
        if (!g.scopes.write) return rejected("FORBIDDEN");
        const p = SavePayload.safeParse(entry.payload);
        if (!p.success) return rejected("INVALID_INPUT");
        const caller: Caller = { ...writeCaller(app, g), channel: "spool_save" };
        const r = await save(app.write, caller, { ...p.data, change: "update" }, { idempotencyKey: key, observedAt });
        if (r.kind !== "result") return rejected("INTERNAL");
        return { idempotency_key: key, outcome: r.outcome.outcome, reason: r.outcome.reason, ...(r.outcome.id ? { id: r.outcome.id } : {}) };
      }
      case "forget": {
        if (!g.scopes.write) return rejected("FORBIDDEN");
        if (app.ctx.clock.now() - Date.parse(entry.observed_at) > FORGET_MAX_AGE_MS) return rejected("forget_not_spooled");
        const p = ForgetPayload.safeParse(entry.payload);
        if (!p.success) return rejected("INVALID_INPUT");
        const r = await forget(app.write, writeCaller(app, g), p.data.id, { idempotencyKey: key, observedAt });
        if (r.kind !== "result") return rejected("INTERNAL");
        return { idempotency_key: key, outcome: r.outcome.outcome, reason: r.outcome.outcome, id: r.outcome.id };
      }
    }
  } catch (e) {
    if (e instanceof WriteError) return rejected(e.code);
    throw e;
  }
}

type LocalCommand = "repo-enable" | "repo-disable" | "project-track" | "project-add" | "review";
const LOCAL_COMMANDS: readonly LocalCommand[] = ["repo-enable", "repo-disable", "project-track", "project-add", "review"];

/** `/v1/admin/<command>` with the local token (owner, T0). Export and import arrive with M2/M3. */
export async function admin(app: App, grant: Grant, command: string, body: unknown): Promise<V1Response> {
  if (!grant.scopes.admin) return apiError("FORBIDDEN", "owner commands need the owner credential");
  if (!(LOCAL_COMMANDS as readonly string[]).includes(command)) return apiError("NOT_FOUND", `no admin command ${command}`);
  const cmd = command as LocalCommand;
  const parsed = ADMIN_ARGS[cmd].safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const args = parsed.data as never;
  try {
    const result =
      cmd === "repo-enable" ? await repoEnable(app.write, args)
      : cmd === "repo-disable" ? repoDisable(app.write, args)
      : cmd === "project-track" ? await projectTrack(app.write, args)
      : cmd === "project-add" ? await projectAdd(app.write, args)
      : review(app.write, args);
    return { status: 200, body: result, op: `admin.${cmd}`, outcome: "ok" };
  } catch (e) {
    return fromWriteError(e);
  }
}
