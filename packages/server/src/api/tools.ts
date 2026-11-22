// The five MCP tools (mcp-interface.md §3), independent of the transport: definitions for
// `tools/list`, and `callTool`, which validates arguments, runs the write or read path and shapes
// the result (`content` text plus `structuredContent`, or an error object with `isError`).

import { createHash } from "node:crypto";
import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import type { ErrorCodeT, ErrorObjectT } from "@memory-anywhere/contracts/schemas/common";
import {
	ERROR_META_KEY,
	IDEMPOTENCY_META_KEY,
	TOOLS,
	TOOL_ORDER,
	WRITE_TOOLS,
	type ToolName,
} from "@memory-anywhere/contracts/schemas/tools";
import { toJsonSchema } from "@memory-anywhere/contracts/json-schema";
import { POLICY_VERSION, TEXTS } from "../policy/generated.ts";
import type { App } from "../app.ts";
import { SERVER_VERSION } from "../app.ts";
import { buildProfile } from "../recall/profile.ts";
import { readPolicy } from "../recall/reader.ts";
import { recall } from "../recall/recall.ts";
import { flagRenderSensitive } from "../recall/render-check.ts";
import { sixHourBucket } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import { forget, mcpIdempotencyKey, save } from "../write/pipeline.ts";
import { toErrorObject, type Caller } from "../write/types.ts";
import type { Grant } from "./grant.ts";
import { clientPolicy } from "../store/client-policy.ts";

/** The owner turned reading off for this app on the admin page. */
const READ_OFF = "the owner turned off reading for this app; it can be turned back on in the admin page under Apps";

const CALL_TIMEOUT_MS = 10_000;

export interface ToolResult {
	readonly content: { type: "text"; text: string }[];
	/** Present on success only. */
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
	return {
		content: [{ type: "text", text: `${code}: ${error.message}` }],
		_meta: { [ERROR_META_KEY]: error },
		isError: true,
	};
}

const ok = (text: string, structured: object): ToolResult => ({
	content: [{ type: "text", text }],
	structuredContent: structured as Record<string, unknown>,
	isError: false,
});

function asError(e: unknown): ToolResult {
	const o = toErrorObject(e);
	return errorResult(o.code, o.message, o.details);
}

/** Whether this call may ask the person a question, and the answer if this is the retry (mcp-interface.md §5). */
export interface Elicitation {
	readonly canElicit: boolean;
	readonly answer: boolean | undefined;
}

const NO_ELICITATION: Elicitation = { canElicit: false, answer: undefined };

/** The write identity of a tool call: channel mcp at T2, with the client's floor (write-path.md §2). */
export function writeCaller(app: App, grant: Grant, elicit: Elicitation = NO_ELICITATION): Caller {
	const sessionKey =
		grant.clientClass === "coding"
			? `${grant.clientId}:${grant.session}`
			: `${grant.clientId}:${sixHourBucket(app.ctx.clock.now())}`;
	return {
		clientId: grant.clientId,
		clientClass: grant.clientClass,
		channel: "mcp",
		tier: 2,
		sessionKey,
		repoKey: grant.repoKey,
		tool: grant.tool,
		floored: clientPolicy(app.ctx.db, grant.clientId)?.save_floor === "observation",
		canElicit: elicit.canElicit,
		elicitationAnswer: elicit.answer,
	};
}

/** A tool call's outcome: a result, or a yes/no question for the person (MRTR input required). */
export type ToolOutcome =
	| { readonly kind: "result"; readonly result: ToolResult; readonly after: AfterResponse }
	| { readonly kind: "question"; readonly question: string };

const nothingAfter: AfterResponse = () => undefined;
const done = (result: ToolResult, after: AfterResponse = nothingAfter): ToolOutcome => ({
	kind: "result",
	result,
	after,
});
const askPerson = (question: string): ToolOutcome => ({ kind: "question", question });

export async function callTool(
	app: App,
	grant: Grant,
	name: string,
	args: unknown,
	meta: Record<string, unknown> | undefined,
	elicit: Elicitation = NO_ELICITATION,
): Promise<ToolOutcome> {
	if (!(TOOL_ORDER as readonly string[]).includes(name))
		return done(errorResult("INVALID_INPUT", `unknown tool ${name}`, { field: "name" }));
	const tool = name as ToolName;
	const policy = readPolicy(app.ctx.db, app.config, grant);
	if (WRITE_TOOLS.has(tool) && !grant.scopes.write)
		return done(
			errorResult(
				"FORBIDDEN",
				"this app was connected without permission to save memories; reconnect it and allow saving",
			),
		);
	if (!WRITE_TOOLS.has(tool) && !grant.scopes.read)
		return done(
			errorResult(
				"FORBIDDEN",
				"this app was connected without permission to read memories; reconnect it and allow reading",
			),
		);
	const parsed = TOOLS[tool].input.safeParse(args ?? {});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return done(
			errorResult("INVALID_INPUT", issue?.message ?? "invalid input", { field: issue?.path.join(".") || "arguments" }),
		);
	}
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<ToolOutcome>((resolve) => {
		timer = setTimeout(
			() => resolve(done(errorResult("STORE_UNAVAILABLE", "the store did not answer in time"))),
			CALL_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([run(app, grant, policy.read, tool, parsed.data as never, meta, elicit), timeout]);
	} catch (e) {
		return done(asError(e));
	} finally {
		clearTimeout(timer);
	}
}

async function run(
	app: App,
	grant: Grant,
	canRead: boolean,
	tool: ToolName,
	args: never,
	meta: Record<string, unknown> | undefined,
	elicit: Elicitation,
): Promise<ToolOutcome> {
	const now = app.ctx.clock.now();
	switch (tool) {
		case "memory_recall": {
			if (!canRead) return done(errorResult("FORBIDDEN", READ_OFF));
			const wait = app.limits.recall.take(grant.clientId);
			if (wait > 0) return done(errorResult("RATE_LIMITED", "recall limit reached", { retry_after_s: wait }));
			const r = await recall(app.read, grant, args);
			return done(ok(r.text, r.output), r.record);
		}
		case "memory_profile": {
			if (!canRead) return done(errorResult("FORBIDDEN", READ_OFF));
			const p = buildProfile(app.ctx.db, grant, readPolicy(app.ctx.db, app.config, grant), new Date(now).toISOString());
			return done(ok(p.output.text, p.output), () => {
				if (p.renderHits.length > 0) transaction(app.ctx.db, () => flagRenderSensitive(app.ctx, grant, p.renderHits));
			});
		}
		case "memory_save": {
			const caller = writeCaller(app, grant, elicit);
			const req = args as Parameters<typeof save>[2];
			const proxyKey =
				typeof meta?.[IDEMPOTENCY_META_KEY] === "string" && grant.clientClass === "coding"
					? (meta[IDEMPOTENCY_META_KEY] as string)
					: undefined;
			const key = proxyKey ?? mcpIdempotencyKey(grant.clientId, req, contentNormHash(req.content), now);
			const r = await save(app.write, caller, req, { idempotencyKey: key, observedAt: now });
			if (r.kind !== "result") return askPerson(r.question);
			const o = r.outcome;
			return done(ok(`${o.outcome}: ${o.message}${o.id ? ` (${o.id})` : ""}`, o));
		}
		case "memory_forget": {
			const { id } = args as { id: string; reason: string };
			const caller = writeCaller(app, grant, elicit);
			const proxyKey =
				typeof meta?.[IDEMPOTENCY_META_KEY] === "string" && grant.clientClass === "coding"
					? (meta[IDEMPOTENCY_META_KEY] as string)
					: undefined;
			// Without a proxy key: one forget of this id per client per 6-hour bucket.
			const key =
				proxyKey ??
				createHash("sha256")
					.update(["forget", grant.clientId, id, String(sixHourBucket(now))].join("\n"))
					.digest("hex");
			const r = await forget(app.write, caller, id, { idempotencyKey: key, observedAt: now });
			if (r.kind !== "result") return askPerson(r.question);
			return done(ok(`${r.outcome.outcome}: ${r.outcome.message}`, r.outcome));
		}
		case "memory_status":
			return done(status(app, grant));
	}
}

function magnitude(n: number): "0" | "1-9" | "10-99" | "100-999" | "1000+" {
	return n === 0 ? "0" : n < 10 ? "1-9" : n < 100 ? "10-99" : n < 1000 ? "100-999" : "1000+";
}

/** memory_status (mcp-interface.md §3.5): never sections, projects, entities or exact counts. */
export function status(app: App, grant: Grant): ToolResult {
	const { db } = app.ctx;
	const policy = readPolicy(db, app.config, grant);
	const row = clientPolicy(db, grant.clientId);
	const memories = (
		prepared(db, "SELECT count(*) AS n FROM memory WHERE status IN ('active','contested')").get() as { n: number }
	).n;
	const failing = (prepared(db, "SELECT count(*) AS n FROM job WHERE status = 'dropped'").get() as { n: number }).n;
	const llm = app.llm.degraded();
	const degraded = [...(llm ? [llm] : []), ...(failing > 0 ? ["jobs_failing" as const] : [])];
	const out = {
		store: app.config.server.mode,
		health: degraded.length > 0 ? "degraded" : "ok",
		...(degraded.length > 0 ? { degraded_reasons: degraded } : {}),
		client: {
			name: policy.displayName,
			class: row?.class ?? grant.clientClass,
			read: policy.read,
			write: row?.write === 1,
			repo_enabled: grant.clientClass === "coding" ? policy.repo !== undefined : null,
		},
		counts_order_of_magnitude: { memories: magnitude(memories) },
		policy_version_server: POLICY_VERSION,
		policy_version_reported: row?.last_policy_version ?? "not reported",
		server_version: SERVER_VERSION,
	};
	return ok(`${out.store} store: ${out.health}; policy ${POLICY_VERSION}; server ${SERVER_VERSION}`, out);
}
