// The five MCP tools (mcp-interface.md §3), independent of the transport: definitions for
// `tools/list`, and `callTool`, which validates arguments, runs the write or read path and shapes
// the result (`content` text plus `structuredContent`, or an error object with `isError`).

import { createHash } from "node:crypto";
import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import type { ErrorCodeT, ErrorObjectT } from "@memory-anywhere/contracts/schemas/common";
import { ERROR_META_KEY, IDEMPOTENCY_META_KEY, TOOLS, TOOL_ORDER, WRITE_TOOLS, type ToolName } from "@memory-anywhere/contracts/schemas/tools";
import { toJsonSchema } from "@memory-anywhere/contracts/json-schema";
import { POLICY_VERSION, TEXTS } from "../policy/generated.ts";
import type { App } from "../app.ts";
import { SERVER_VERSION } from "../app.ts";
import { buildProfile } from "../recall/profile.ts";
import { readPolicy } from "../recall/reader.ts";
import { recall } from "../recall/recall.ts";
import { flagRenderSensitive } from "../recall/render-check.ts";
import { prepared, transaction } from "../store/db.ts";
import { forget, mcpIdempotencyKey, save } from "../write/pipeline.ts";
import { WriteError, type Caller } from "../write/types.ts";
import type { Grant } from "./grant.ts";

const CALL_TIMEOUT_MS = 10_000;

export interface ToolResult {
  readonly content: { type: "text"; text: string }[];
  /** Present on success only (spec-issues #50). */
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  readonly isError: boolean;
}

/** Called after the response is sent: the recall ledger and render-time reviews (retrieval.md §2 step 11). */
export type AfterResponse = () => void;

const DESCRIPTION: Record<ToolName, string> = {
  memory_recall: TEXTS["desc-memory_recall"],
  memory_profile: TEXTS["desc-memory_profile"],
  memory_save: TEXTS["desc-memory_save"],
  memory_forget: TEXTS["desc-memory_forget"],
  memory_status: TEXTS["desc-memory_status"],
};

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly annotations: (typeof TOOLS)[ToolName]["annotations"];
  readonly _meta: Record<string, unknown>;
}

const DEFINITIONS: readonly ToolDefinition[] = TOOL_ORDER.map((name) => ({
  name,
  title: TOOLS[name].annotations.title,
  description: DESCRIPTION[name],
  inputSchema: toJsonSchema(TOOLS[name].input, "input"),
  outputSchema: toJsonSchema(TOOLS[name].output, "output"),
  annotations: TOOLS[name].annotations,
  _meta: { "anthropic/alwaysLoad": true },
}));

/** `tools/list` in the fixed order; a read-only client gets no write tools (mcp-interface.md §1). */
export function toolDefinitions(canWrite: boolean): readonly ToolDefinition[] {
  return DEFINITIONS.filter((d) => canWrite || !WRITE_TOOLS.has(d.name));
}

export function errorResult(code: ErrorCodeT, message: string, extra: Partial<ErrorObjectT> = {}): ToolResult {
  const error: ErrorObjectT = { code, message: message.slice(0, 300), ...extra };
  return { content: [{ type: "text", text: `${code}: ${error.message}` }], _meta: { [ERROR_META_KEY]: error }, isError: true };
}

const ok = (text: string, structured: object): ToolResult => ({ content: [{ type: "text", text }], structuredContent: structured as Record<string, unknown>, isError: false });

function asError(e: unknown): ToolResult {
  if (e instanceof WriteError) {
    return errorResult(e.code, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.retryAfterS ? { retry_after_s: e.retryAfterS } : {}) });
  }
  if (e instanceof Error && /SQLITE_BUSY|database is locked/iu.test(e.message)) return errorResult("STORE_UNAVAILABLE", "the store is busy; try again shortly");
  return errorResult("INTERNAL", "internal error");
}

/** Whether this call may ask the person a question, and the answer if this is the retry (mcp-interface.md §5). */
export interface Elicitation {
  readonly canElicit: boolean;
  readonly answer: boolean | undefined;
}

const NO_ELICITATION: Elicitation = { canElicit: false, answer: undefined };

/** The write identity of a tool call: channel mcp at T2, with the client's floor (write-path.md §2). */
export function writeCaller(app: App, grant: Grant, elicit: Elicitation = NO_ELICITATION): Caller {
  const floor = prepared(app.ctx.db, "SELECT save_floor FROM client_policy WHERE client_id = ?").get(grant.clientId) as { save_floor: string } | undefined;
  const sessionKey = grant.clientClass === "coding"
    ? `${grant.clientId}:${grant.session}`
    : `${grant.clientId}:${Math.floor(app.ctx.clock.now() / 1000 / 21_600)}`;
  return {
    clientId: grant.clientId, clientClass: grant.clientClass, channel: "mcp", tier: 2, sessionKey, repoKey: grant.repoKey, tool: grant.tool,
    floored: floor?.save_floor === "observation", canElicit: elicit.canElicit, elicitationAnswer: elicit.answer,
  };
}

/** A tool call's outcome: a result, or a yes/no question for the person (MRTR input required). */
export interface ToolOutcome {
  readonly result: ToolResult;
  readonly after: AfterResponse;
  readonly question?: string;
}

export async function callTool(app: App, grant: Grant, name: string, args: unknown, meta: Record<string, unknown> | undefined, elicit: Elicitation = NO_ELICITATION): Promise<ToolOutcome> {
  const none: AfterResponse = () => undefined;
  if (!(TOOL_ORDER as readonly string[]).includes(name)) return { result: errorResult("INVALID_INPUT", `unknown tool ${name}`, { field: "name" }), after: none };
  const tool = name as ToolName;
  const policy = readPolicy(app.ctx.db, grant);
  if (WRITE_TOOLS.has(tool) && !grant.scopes.write) return { result: errorResult("FORBIDDEN", "this grant cannot write"), after: none };
  if (!WRITE_TOOLS.has(tool) && !grant.scopes.read) return { result: errorResult("FORBIDDEN", "this grant cannot read"), after: none };
  const parsed = TOOLS[tool].input.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { result: errorResult("INVALID_INPUT", issue?.message ?? "invalid input", { field: issue?.path.join(".") || "arguments" }), after: none };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ToolOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ result: errorResult("STORE_UNAVAILABLE", "the store did not answer in time"), after: none }), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(app, grant, policy.read, tool, parsed.data as never, meta, elicit), timeout]);
  } catch (e) {
    return { result: asError(e), after: none };
  } finally {
    clearTimeout(timer);
  }
}

async function run(app: App, grant: Grant, canRead: boolean, tool: ToolName, args: never, meta: Record<string, unknown> | undefined, elicit: Elicitation): Promise<ToolOutcome> {
  const none: AfterResponse = () => undefined;
  const now = app.ctx.clock.now();
  switch (tool) {
    case "memory_recall": {
      if (!canRead) return { result: errorResult("FORBIDDEN", "this app may not read memories"), after: none };
      const wait = app.limits.recall.take(grant.clientId);
      if (wait > 0) return { result: errorResult("RATE_LIMITED", "recall limit reached", { retry_after_s: wait }), after: none };
      const r = await recall(app.read, grant, args);
      return { result: ok(r.text, r.output), after: r.record };
    }
    case "memory_profile": {
      if (!canRead) return { result: errorResult("FORBIDDEN", "this app may not read memories"), after: none };
      const p = buildProfile(app.ctx.db, app.config, grant, readPolicy(app.ctx.db, grant), new Date(now).toISOString());
      return {
        result: ok(p.output.text, p.output),
        after: () => {
          if (p.renderHits.length > 0) transaction(app.ctx.db, () => flagRenderSensitive(app.ctx, grant, p.renderHits));
        },
      };
    }
    case "memory_save": {
      const caller = writeCaller(app, grant, elicit);
      const req = args as Parameters<typeof save>[2];
      const proxyKey = typeof meta?.[IDEMPOTENCY_META_KEY] === "string" && grant.clientClass === "coding" ? (meta[IDEMPOTENCY_META_KEY] as string) : undefined;
      const key = proxyKey ?? mcpIdempotencyKey(grant.clientId, req, contentNormHash(req.content), now);
      const r = await save(app.write, caller, req, { idempotencyKey: key, observedAt: now });
      if (r.kind !== "result") return { result: errorResult("INTERNAL", "confirmation needed"), after: none, question: r.question };
      const o = r.outcome;
      return { result: ok(`${o.outcome}: ${o.message}${o.id ? ` (${o.id})` : ""}`, o), after: none };
    }
    case "memory_forget": {
      const { id } = args as { id: string; reason: string };
      const caller = writeCaller(app, grant, elicit);
      const proxyKey = typeof meta?.[IDEMPOTENCY_META_KEY] === "string" && grant.clientClass === "coding" ? (meta[IDEMPOTENCY_META_KEY] as string) : undefined;
      // Without a proxy key: one forget of this id per client per 6-hour bucket (spec-issues #40).
      const key = proxyKey ?? createHash("sha256").update(["forget", grant.clientId, id, String(Math.floor(now / 1000 / 21_600))].join("\n")).digest("hex");
      const r = await forget(app.write, caller, id, { idempotencyKey: key, observedAt: now });
      if (r.kind !== "result") return { result: errorResult("INTERNAL", "confirmation needed"), after: none, question: r.question };
      return { result: ok(`${r.outcome.outcome}: ${r.outcome.message}`, r.outcome), after: none };
    }
    case "memory_status":
      return { result: status(app, grant), after: none };
  }
}

function magnitude(n: number): "0" | "1-9" | "10-99" | "100-999" | "1000+" {
  return n === 0 ? "0" : n < 10 ? "1-9" : n < 100 ? "10-99" : n < 1000 ? "100-999" : "1000+";
}

/** memory_status (mcp-interface.md §3.5): never sections, projects, entities or exact counts. */
export function status(app: App, grant: Grant): ToolResult {
  const { db } = app.ctx;
  const policy = readPolicy(db, grant);
  const row = prepared(db, "SELECT write, class, last_policy_version FROM client_policy WHERE client_id = ?").get(grant.clientId) as
    | { write: number; class: "chat" | "coding"; last_policy_version: string | null }
    | undefined;
  const memories = (prepared(db, "SELECT count(*) AS n FROM memory WHERE status IN ('active','contested')").get() as { n: number }).n;
  const failing = (prepared(db, "SELECT count(*) AS n FROM job WHERE status = 'dropped'").get() as { n: number }).n;
  const llm = app.llm.degraded();
  const degraded = [...(llm ? [llm] : []), ...(failing > 0 ? ["jobs_failing" as const] : [])];
  const out = {
    store: app.config.server.mode,
    health: degraded.length > 0 ? "degraded" : "ok",
    ...(degraded.length > 0 ? { degraded_reasons: degraded } : {}),
    client: {
      name: policy.displayName, class: row?.class ?? grant.clientClass, read: policy.read, write: row?.write === 1,
      repo_enabled: grant.clientClass === "coding" ? policy.repo !== undefined : null,
    },
    counts_order_of_magnitude: { memories: magnitude(memories) },
    policy_version_server: POLICY_VERSION,
    policy_version_reported: row?.last_policy_version ?? "not reported",
    server_version: SERVER_VERSION,
  };
  return ok(`${out.store} store: ${out.health}; policy ${POLICY_VERSION}; server ${SERVER_VERSION}`, out);
}
