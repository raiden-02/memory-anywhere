// Suite C, remote targets (evals.md §3.7): latency from the owner's PC to a deployed eval stage,
// through the same endpoints the client uses, as the PC's own grant:
//
//   1 pair a PC (memory-anywhere-cli, loopback redirect) as the eval owner (deployed.ts)
//   2 enable a repo through /v1/admin with the owner's step-up approval, then save 300 memories
//   3 SessionStart: /v1/session-start, cold (a new TCP and TLS connection each time) and warm
//   4 memory_recall and memory_save through /mcp, warm
//
// Targets: SessionStart p95 ≤ 800 ms warm, ≤ 1.5 s cold; recall p95 ≤ 1.2 s; save p95 ≤ 1.5 s
// without an LLM key (eval stacks have none). Calls are paced under the stage's production rate
// limits, so no measured call ever waited out a 429.

import { request as httpsRequest } from "node:https";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SERVER_VERSION } from "../../packages/server/src/app.ts";
import {
	connectDeployed,
	type DeployedEnv,
	type DeployedTarget,
} from "../../packages/server/test/oauth-conformance/deployed.ts";
import {
	authorize,
	openWindow,
	pkce,
	token,
	type Browser,
} from "../../packages/server/test/oauth-conformance/issuer.ts";

const REPO = "rk_c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const PC_REDIRECT = "http://127.0.0.1:50124/callback";
const TOPICS = [
	"pnpm workspaces",
	"rust lifetimes",
	"postgres indexes",
	"kubernetes probes",
	"react suspense",
	"terraform state",
	"python typing",
	"go generics",
	"swift actors",
	"css grid",
];
const QUERIES = [
	"how does the user manage monorepos",
	"database performance habits",
	"preferred deployment checks",
	"frontend data loading",
	"infrastructure tooling",
	"typing preferences in python",
	"concurrency in swift",
	"layout approach in css",
	"memory safety in rust",
	"generic code in go",
];
/** /mcp allows 120 calls a minute per grant: one call every 600 ms stays under it. */
const PACE_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Latency {
	readonly n: number;
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
}

export interface SuiteCRemoteResult {
	readonly suite: "C";
	readonly target: "remote";
	readonly session_start_warm_ms: Latency;
	readonly session_start_cold_ms: Latency;
	readonly recall_ms: Latency;
	readonly save_ms: Latency;
	readonly pass: {
		readonly session_start_warm: boolean;
		readonly session_start_cold: boolean;
		readonly recall: boolean;
		readonly save: boolean;
	};
}

function latency(xs: readonly number[]): Latency {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number): number => Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? NaN);
	return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] ?? NaN) };
}

/** The PC's grant, as `mema login` gets it after the owner opens a PC window. */
async function pcAccess(target: DeployedTarget, owner: Browser): Promise<string> {
	await openWindow(target, owner, { vendor: "pc", method: "static", machineName: "suite c" });
	const p = pkce();
	const back = await authorize(target, owner, {
		client_id: "memory-anywhere-cli",
		redirect_uri: PC_REDIRECT,
		code_challenge: p.challenge,
		code_challenge_method: "S256",
		scope: "memory.read memory.write memory.capture offline_access",
	});
	const t = await token(target, {
		grant_type: "authorization_code",
		code: back.searchParams.get("code") ?? "",
		redirect_uri: PC_REDIRECT,
		code_verifier: p.verifier,
		client_id: "memory-anywhere-cli",
	});
	if (t.status !== 200) throw new Error(`PC token: ${JSON.stringify(t.data)}`);
	return String(t.data["access_token"]);
}

/** An owner command from the PC: step-up, the owner approves with a passkey, then the call (stepup.ts). */
async function approvedAdminCall(
	target: DeployedTarget,
	owner: Browser,
	headers: Record<string, string>,
	command: string,
	args: Record<string, unknown>,
): Promise<void> {
	const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
		fetch(`${target.origin}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
	const started = (await (await post("/v1/admin/stepup", { command, args })).json()) as { request_id: string };
	const base = `${target.adminOrigin}/approve/${started.request_id}`;
	await owner.fetch(base);
	const options = await owner.postJson(`${base}/options`);
	const approved = await owner.postJson(`${base}/approve`, {
		response: target.authenticator.get(options.data as never),
	});
	if (approved.status !== 200) throw new Error(`approve ${command}: ${JSON.stringify(approved)}`);
	const status = (await (
		await fetch(`${target.origin}/v1/admin/stepup/${started.request_id}`, { headers })
	).json()) as { token?: string };
	const done = await post(`/v1/admin/${command}`, args, { "ma-step-up": status.token ?? "" });
	if (done.status !== 200) throw new Error(`${command}: ${done.status} ${await done.text()}`);
}

/** One request on a fresh connection (no keep-alive): DNS, TCP and TLS included, as a cold hook pays. */
function coldPost(url: string, headers: Record<string, string>, body: unknown): Promise<number> {
	return new Promise((resolve, reject) => {
		const t = performance.now();
		const req = httpsRequest(url, { method: "POST", agent: false, headers }, (res) => {
			res.resume();
			res.on("end", () =>
				res.statusCode === 200 ? resolve(performance.now() - t) : reject(new Error(`session-start ${res.statusCode}`)),
			);
		});
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

export async function runSuiteCRemote(
	e: DeployedEnv,
	o: { calls?: number; log?: (l: string) => void } = {},
): Promise<SuiteCRemoteResult> {
	const calls = o.calls ?? 100;
	const target = connectDeployed(e);
	const owner = await target.owner();
	const access = await pcAccess(target, owner);
	const headers = {
		authorization: `Bearer ${access}`,
		"content-type": "application/json",
		"ma-client-version": SERVER_VERSION,
		"ma-repo-key": REPO,
		"ma-tool": "claude-code",
	};
	await approvedAdminCall(target, owner, headers, "repo-enable", {
		repo_key: REPO,
		display_name: "suite c",
		capture: false,
	});
	o.log?.("PC paired, repo enabled");

	// 300 memories through /v1/writes, as the spool sends them (100 per batch).
	const now = Date.now();
	for (let batch = 0; batch < 3; batch++) {
		const entries = Array.from({ length: 100 }, (_, k) => {
			const n = batch * 100 + k;
			const topic = TOPICS[n % TOPICS.length] as string;
			return {
				idempotency_key: `spl_01JC9Z3N4V8Q2W5X7Y9R${String(n).padStart(6, "0")}`,
				op: "save",
				observed_at: new Date(now).toISOString(),
				repo_key: REPO,
				session_id: `cr${batch}`,
				payload: {
					content: `Prefers ${topic} approach number ${n} for team projects`,
					kind: "fact",
					why_durable: "working style",
					explicit_request: true,
					user_words: `remember i prefer ${topic} approach number ${n} for team projects`,
				},
			};
		});
		const r = await fetch(`${target.origin}/v1/writes`, { method: "POST", headers, body: JSON.stringify({ entries }) });
		if (r.status !== 200) throw new Error(`writes: ${r.status} ${await r.text()}`);
	}
	o.log?.("300 memories written");

	const startBody = (i: number) => ({
		tool: "claude-code",
		repo_key: REPO,
		session_id: `c-session-${i}`,
		max_chars: 9000,
	});
	const cold: number[] = [];
	for (let i = 0; i < 20; i++) {
		cold.push(await coldPost(`${target.origin}/v1/session-start`, headers, startBody(i)));
		await sleep(PACE_MS);
	}
	const warm: number[] = [];
	for (let i = 0; i < calls; i++) {
		const t = performance.now();
		const r = await fetch(`${target.origin}/v1/session-start`, {
			method: "POST",
			headers,
			body: JSON.stringify(startBody(100 + i)),
		});
		await r.arrayBuffer();
		if (r.status !== 200) throw new Error(`session-start ${r.status}`);
		warm.push(performance.now() - t);
		await sleep(PACE_MS);
	}
	o.log?.("session starts measured");

	const client = new Client({ name: "suite-c-remote", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
			requestInit: { headers: { authorization: headers.authorization } },
		}),
	);
	await client.callTool({ name: "memory_recall", arguments: { query: "warm up the model" } });
	const recall: number[] = [];
	for (let i = 0; i < calls; i++) {
		const t = performance.now();
		await client.callTool({ name: "memory_recall", arguments: { query: QUERIES[i % QUERIES.length] as string } });
		recall.push(performance.now() - t);
		await sleep(PACE_MS);
	}
	// Saves are limited to 40 an hour for a coding client: 30 distinct facts.
	const save: number[] = [];
	for (let i = 0; i < 30; i++) {
		const t = performance.now();
		await client.callTool({
			name: "memory_save",
			arguments: {
				content: `Uses build tool number ${i} for side projects`,
				kind: "fact",
				why_durable: "tooling",
				explicit_request: true,
				user_words: `remember i use build tool number ${i} for side projects`,
			},
		});
		save.push(performance.now() - t);
		await sleep(PACE_MS);
	}
	await client.close();

	const r = { warm: latency(warm), cold: latency(cold), recall: latency(recall), save: latency(save) };
	return {
		suite: "C",
		target: "remote",
		session_start_warm_ms: r.warm,
		session_start_cold_ms: r.cold,
		recall_ms: r.recall,
		save_ms: r.save,
		pass: {
			session_start_warm: r.warm.p95 <= 800,
			session_start_cold: r.cold.p95 <= 1500,
			recall: r.recall.p95 <= 1200,
			save: r.save.p95 <= 1500,
		},
	};
}
