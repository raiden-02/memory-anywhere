// Suite S, the eval-stack cases (evals.md §3.5): the checks that need a real
// deployed stage. Run from the PC with the deploy profile, as the eval owner (deployed.ts):
//
//   pnpm eval run --suite S --stack https://eval.{host} --stage eval-<id> --owner <file outside the repo>
//
//   S-AWS-01..02  selfcheck on the instance: IMDS refused for the server and Caddy users
//   S-AWS-03..08  from the PC: the bucket policy, CAA, DNS, port 80, and the deploy role's limits
//   S-AWS-09      `mema destroy` with a record still pointing at the IP: checked when the stage is
//                 destroyed, so reported "not run here"
//   S-PURGE-23..26  save a canary, purge it as the owner, then a selfcheck that first compacts the
//                   store with ma-maint (as that night would): the canary is in no file, not on the
//                   raw device, not in swap
//
// Each verdict comes from a response, an AWS error code or the instance's own selfcheck result;
// never from a model's text. The selfcheck result holds ids, pass/fail and counts, never a canary.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { promisify } from "node:util";
import { caaAllowsOnlyLetsEncrypt, classifyName, resolveA, resolveCaa } from "../../packages/client/src/deploy/dns.ts";
import {
	connectDeployed,
	retryRateLimited,
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
import type { AttackCase, CaseResult } from "./suite-s.ts";

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface StackOptions extends DeployedEnv {
	log: (line: string) => void;
}

interface Selfcheck {
	at: string;
	checks: { id: string; pass: boolean; detail: string }[];
}

/** The deploy profile's AWS CLI: stdout on success, the error code on refusal. */
async function aws(o: StackOptions, args: string[]): Promise<{ ok: true; out: string } | { ok: false; code: string }> {
	try {
		const { stdout } = await run("aws", [...args, "--profile", o.profile, "--region", o.region, "--output", "json"], {
			env: { ...process.env, MSYS_NO_PATHCONV: "1" },
		});
		return { ok: true, out: stdout };
	} catch (e) {
		const text = String((e as { stderr?: string }).stderr ?? (e as Error).message);
		return { ok: false, code: /\(([A-Za-z]+)\)/u.exec(text)?.[1] ?? text.trim().split("\n").pop() ?? "error" };
	}
}

async function stackOutputs(o: StackOptions): Promise<Record<string, string>> {
	const r = await aws(o, [
		"cloudformation",
		"describe-stacks",
		"--stack-name",
		`MemoryAnywhere-${o.stage}`,
		"--query",
		"Stacks[0].Outputs",
	]);
	if (!r.ok) throw new Error(`reading the stack: ${r.code}`);
	return Object.fromEntries(
		(JSON.parse(r.out) as { OutputKey: string; OutputValue: string }[]).map((x) => [x.OutputKey, x.OutputValue]),
	);
}

/** Whether a TCP connection to host:port is refused or times out (true) or is accepted (false). */
function portClosed(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host, port, timeout: 5_000 });
		s.once("connect", () => (s.destroy(), resolve(false)));
		s.once("timeout", () => (s.destroy(), resolve(true)));
		s.once("error", () => resolve(true));
	});
}

/** The CAA records that apply to a name: its own, else its closest ancestor's (RFC 8659 §3). */
async function effectiveCaa(name: string): Promise<{ at: string; records: string[] }> {
	const labels = name.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const at = labels.slice(i).join(".");
		const records = await resolveCaa(fetch, at);
		if (records.length > 0) return { at, records };
	}
	return { at: name, records: [] };
}

/** A grant for one MCP client, as an app gets it after the owner pairs it. */
async function claudeAccess(target: DeployedTarget, owner: Browser): Promise<string> {
	const w = await openWindow(target, owner, { vendor: "claude", method: "static" });
	const c = w.credentials;
	if (!c) throw new Error("no static credentials");
	const p = pkce();
	const back = await authorize(target, owner, {
		client_id: c.client_id,
		redirect_uri: c.redirect_uris[0] ?? "",
		code_challenge: p.challenge,
		code_challenge_method: "S256",
	});
	const t = await token(
		target,
		{
			grant_type: "authorization_code",
			code: back.searchParams.get("code") ?? "",
			redirect_uri: c.redirect_uris[0] ?? "",
			code_verifier: p.verifier,
		},
		{ id: c.client_id, secret: c.client_secret },
	);
	if (t.status !== 200) throw new Error(`token: ${JSON.stringify(t.data)}`);
	return String(t.data["access_token"]);
}

async function saveCanary(target: DeployedTarget, access: string, canary: string): Promise<string> {
	const res = await fetch(target.mcpUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${access}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "memory_save",
				arguments: {
					content: `Keeps a spare key code ${canary}`,
					kind: "fact",
					why_durable: "eval canary",
					user_words: `remember my spare key code is ${canary}`,
					explicit_request: true,
				},
			},
		}),
	});
	const text = await res.text();
	const json = text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}");
	const id = (JSON.parse(json) as { result?: { structuredContent?: { id?: string } } }).result?.structuredContent?.id;
	if (!id?.startsWith("mem_")) throw new Error(`the canary was not stored: ${text.slice(0, 300)}`);
	return id;
}

/** An owner action, with the passkey step-up when it asks for one. */
async function act(
	target: DeployedTarget,
	owner: Browser,
	action: string,
	input: Record<string, unknown>,
): Promise<void> {
	const url = `${target.adminOrigin}/api/act/${action}`;
	let r = await owner.postJson(url, { input });
	if (r.data["error"] === "step_up_required") {
		const options = await owner.postJson(`${target.adminOrigin}/api/stepup/options`);
		await owner.postJson(`${target.adminOrigin}/api/stepup/verify`, target.authenticator.get(options.data as never));
		r = await owner.postJson(url, { input });
	}
	if (r.status !== 200) throw new Error(`${action}: ${JSON.stringify(r)}`);
}

/** Posts the canaries, then waits for ma-selfcheck.service's result (it compacts, then scans the whole device). */
async function selfcheck(target: DeployedTarget, owner: Browser, canaries: string[]): Promise<Selfcheck> {
	const asked = Date.now();
	const posted = await owner.postJson(`${target.adminOrigin}/api/selfcheck`, { canaries, compact: true });
	if (posted.status !== 202) throw new Error(`selfcheck request: ${JSON.stringify(posted)}`);
	for (let i = 0; i < 120; i++) {
		await sleep(15_000);
		// ma-maint restarts the server while it compacts: a 502 meanwhile is expected.
		const res = await owner.fetch(`${target.adminOrigin}/api/selfcheck`).catch(() => undefined);
		if (res?.status !== 200) continue;
		const r = (await res.json()) as Selfcheck;
		if (Date.parse(r.at) >= asked - 5_000) return r;
	}
	throw new Error("no selfcheck result within 30 minutes");
}

export async function runStackCases(cases: readonly AttackCase[], o: StackOptions): Promise<CaseResult[]> {
	globalThis.fetch = retryRateLimited(globalThis.fetch);
	const target = connectDeployed(o);
	const owner = await target.owner();
	const host = new URL(o.origin).hostname;
	const out = await stackOutputs(o);
	const ip = out["ElasticIp"] ?? "";
	const verdicts = new Map<string, { pass: boolean; evidence: string }>();
	const set = (id: string, pass: boolean, evidence: string): void => {
		verdicts.set(id, { pass, evidence });
		o.log(`${id} ${pass ? "pass" : "FAIL"}: ${evidence}`);
	};

	// ---- from the PC ----
	const anonymous = await fetch(`https://${out["BackupBucket"]}.s3.amazonaws.com/?list-type=2`);
	const withRole = await aws(o, [
		"s3api",
		"list-objects-v2",
		"--bucket",
		out["BackupBucket"] ?? "",
		"--max-items",
		"1",
	]);
	set(
		"S-AWS-03",
		anonymous.status === 403 && !withRole.ok,
		`anonymous ${anonymous.status}; deploy role ${withRole.ok ? "allowed" : withRole.code}`,
	);

	const caa = await effectiveCaa(host);
	set(
		"S-AWS-04",
		caaAllowsOnlyLetsEncrypt(caa.records),
		`CAA at ${caa.at === host ? "the stage host" : "its parent"}: ${caa.records.join("; ") || "none"}`,
	);

	const names = [host, `admin.${host}`];
	const states = await Promise.all(names.map(async (n) => classifyName(await resolveA(fetch, n), ip).kind));
	set(
		"S-AWS-05",
		states.every((s) => s === "ready"),
		`both names: ${states.join(", ")} (ready = the Elastic IP, not a proxy)`,
	);

	set("S-AWS-06", await portClosed(host, 80), "port 80 refused or silent");

	const prodSecret = await aws(o, ["ssm", "get-parameter", "--name", "/memory-anywhere/llm-key", "--with-decryption"]);
	const session = await aws(o, ["ssm", "start-session", "--target", out["InstanceId"] ?? ""]);
	set(
		"S-AWS-07",
		!prodSecret.ok &&
			prodSecret.code === "AccessDeniedException" &&
			!session.ok &&
			session.code === "AccessDeniedException",
		`prod secret ${prodSecret.ok ? "READ" : prodSecret.code}; session ${session.ok ? "STARTED" : session.code}`,
	);

	const probe = `/memory-anywhere-${o.stage}/s-aws-08`;
	const value = randomBytes(9).toString("base64url");
	const put = await aws(o, [
		"ssm",
		"put-parameter",
		"--name",
		probe,
		"--type",
		"SecureString",
		"--value",
		value,
		"--overwrite",
	]);
	const viaSsm = await aws(o, [
		"ssm",
		"get-parameter",
		"--name",
		probe,
		"--with-decryption",
		"--query",
		"Parameter.Value",
	]);
	const raw = await aws(o, ["ssm", "get-parameter", "--name", probe, "--query", "Parameter.Value"]);
	const ciphertext = raw.ok ? (JSON.parse(raw.out) as string) : "";
	const direct = await aws(o, [
		"kms",
		"decrypt",
		"--ciphertext-blob",
		ciphertext,
		"--encryption-context",
		`PARAMETER_ARN=arn:aws:ssm:${o.region}:${(out["KeyArn"] ?? "").split(":")[4] ?? ""}:parameter${probe}`,
	]);
	await aws(o, ["ssm", "delete-parameter", "--name", probe]);
	const decrypted = viaSsm.ok && JSON.parse(viaSsm.out) === value;
	set(
		"S-AWS-08",
		put.ok && decrypted && !direct.ok && direct.code === "AccessDeniedException",
		`put ${put.ok ? "ok" : put.code}; through SSM ${decrypted ? "decrypted" : viaSsm.ok ? "wrong value" : viaSsm.code}; direct KMS ${direct.ok ? "DECRYPTED" : direct.code}; prod: see S-AWS-07`,
	);

	// ---- on the instance ----
	const canary = `Quarry${randomBytes(6).toString("hex")}`;
	const access = await claudeAccess(target, owner);
	const memoryId = await saveCanary(target, access, canary);
	const purgedAt = Date.now();
	await act(target, owner, "memory.purge", { id: memoryId });
	o.log(`canary saved and purged (${memoryId}); selfcheck compacts the store, then scans`);
	const result = await selfcheck(target, owner, [canary]);
	const ok = (prefix: string): boolean =>
		result.checks.filter((c) => c.id.startsWith(prefix)).length > 0 &&
		result.checks.filter((c) => c.id.startsWith(prefix)).every((c) => c.pass);
	const detail = (prefix: string): string =>
		result.checks
			.filter((c) => c.id.startsWith(prefix))
			.map((c) => `${c.id} ${c.pass ? "pass" : "FAIL"} (${c.detail})`)
			.join("; ") || "no such check ran";
	set("S-AWS-01", ok("imds.denied.memory-anywhere"), detail("imds.denied.memory-anywhere"));
	set("S-AWS-02", ok("imds.denied.caddy"), detail("imds.denied.caddy"));
	set(
		"S-PURGE-23",
		ok("maint.compacted") && ok("purge.raw-device") && ok("purge.data-dir"),
		`${detail("maint.compacted")}; ${detail("purge.raw-device")}; ${detail("purge.data-dir")}`,
	);
	set("S-PURGE-24", ok("purge.swap"), detail("purge.swap"));
	set("S-PURGE-25", ok("litestream.no-staging-on-volume"), detail("litestream.no-staging-on-volume"));
	const gone = ok("maint.compacted") && ok("purge.raw-device") && ok("purge.swap") && ok("purge.data-dir");
	set(
		"S-PURGE-26",
		gone,
		`canary gone from every file ${Math.round((Date.parse(result.at) - purgedAt) / 60_000)} min after the purge (purge, then ma-maint, then the scan)`,
	);

	return cases.map((c) => {
		const v = verdicts.get(c.id);
		if (v) return { id: c.id, family: c.family, verdict: v.pass ? "pass" : "fail", evidence: v.evidence };
		return {
			id: c.id,
			family: c.family,
			verdict: "not_run",
			evidence:
				c.id === "S-AWS-09"
					? "checked when the stage is destroyed (mema destroy waits while a record resolves)"
					: "no stack check for this case",
		};
	});
}
