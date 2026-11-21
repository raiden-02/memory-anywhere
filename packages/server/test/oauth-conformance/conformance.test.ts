// OAuth conformance tests 1–20 (auth-and-security.md §12) against the product server on loopback (issuer.ts),
// or against a deployed eval stage over the network when MA_CONFORMANCE_ORIGIN is set (deployed.ts).
// Each test names the rule it checks in auth-and-security.md. Tests share one server and run in
// order: a pairing window is server-wide state, exactly as in production.
//
// Deployed, time really passes (the 30 s refresh grace, window expiry, MRTR expiry), and the parts
// that need the server's internals or a fake vendor network run locally only: CIMD documents served
// by the test (8c, 8d, and 13's redirecting and private targets), a cold start (6), the owner's
// consent session ending (11c), and the unit-level MRTR checks (20); 20b checks the same MRTR rules
// through /mcp on both targets.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { argsDigest, consumeElicitation, startElicitation } from "../../src/api/mrtr.ts";
import { connectDeployed, deployedEnv, retryRateLimited } from "./deployed.ts";
import { routeInventory } from "./routes.ts";
import {
	authorize,
	authUrl,
	Browser,
	callMcp,
	openWindow,
	ownerSetup,
	pkce,
	startIssuer,
	token,
	type Issuer,
	type Target,
} from "./issuer.ts";

const deployed = deployedEnv();
/** Deployed, a test waits out rate limits and real time: minutes, not seconds. */
const timeout = (ms: number): number => (deployed ? 30 * 60_000 : ms);
if (deployed) vi.setConfig({ testTimeout: timeout(0), hookTimeout: timeout(0) });
const localOnly = test.skipIf(deployed !== undefined);
const deployedOnly = test.runIf(deployed !== undefined);

const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CIMD = "https://chatgpt.com/oauth/client.json";
const CLAUDE_CODE_CIMD = "https://claude.ai/oauth/claude-code-client-metadata";

// ---- the network seen by CIMD fetches ----

/** CIMD documents by client_id URL; a function answers with any Response. */
const documents = new Map<string, unknown>();
const fetched: string[] = [];
let privateTarget = "";

function cimdDoc(clientId: string, redirects: string[], extra: Record<string, unknown> = {}) {
	return {
		client_id: clientId,
		client_name: "Test vendor",
		redirect_uris: redirects,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...extra,
	};
}

const network = async (url: string | URL, options: RequestInit): Promise<Response> => {
	const id = String(url);
	fetched.push(id);
	if (id.includes("/private/")) return fetch(privateTarget, options); // keeps the library's SSRF dispatcher
	if (id.includes("/redirecting/")) return new Response(null, { status: 302, headers: { location: CHATGPT_CIMD } });
	const doc = documents.get(id);
	return doc
		? new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } })
		: new Response("not found", { status: 404 });
};

/** The server under test; `local` is the same server when it runs in this process. */
let issuer: Target;
let local: Issuer | undefined;
let owner: Browser;
let docServer: Server | undefined;
let docHits = 0;

beforeAll(async () => {
	if (deployed) {
		globalThis.fetch = retryRateLimited(globalThis.fetch);
		const target = connectDeployed(deployed);
		issuer = target;
		owner = await target.owner();
		return;
	}
	// A server on a private address that would serve a valid document if the fetch reached it.
	const doc = (docServer = createServer((_req, res) => {
		docHits++;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(cimdDoc("https://chatgpt.com/oauth/private/client.json", [CHATGPT_REDIRECT])));
	}));
	await new Promise<void>((r) => doc.listen(0, "127.0.0.1", r));
	privateTarget = `http://127.0.0.1:${(doc.address() as AddressInfo).port}/client.json`;
	issuer = local = await startIssuer({ fetch: network as never });
	owner = await ownerSetup(issuer);
}, timeout(60_000)); // owner setup hashes 10 recovery codes with argon2id (64 MiB each)

afterAll(async () => {
	await local?.stop();
	await new Promise<void>((r) => (docServer ? docServer.close(() => r()) : r()));
});

/** Time passing: the server's clock locally, real waiting against a deployed stage. */
async function elapse(ms: number): Promise<void> {
	if (local) local.clock.advance(ms);
	else await new Promise((r) => setTimeout(r, ms));
}

// ---- helpers ----

async function staticWindow(vendor = "claude", extra: Record<string, unknown> = {}) {
	const w = await openWindow(issuer, owner, { vendor, method: "static", ...extra });
	const c = w.credentials;
	if (!c) throw new Error("no static credentials");
	return { w, id: c.client_id, secret: c.client_secret, redirect: c.redirect_uris[0] ?? "" };
}

/** Pair, authorize and exchange the code: the tokens a vendor ends up with. */
async function staticGrant(vendor = "claude", extra: Record<string, unknown> = {}) {
	const s = await staticWindow(vendor, extra);
	const p = pkce();
	const back = await authorize(issuer, owner, {
		client_id: s.id,
		redirect_uri: s.redirect,
		code_challenge: p.challenge,
		code_challenge_method: "S256",
	});
	const code = back.searchParams.get("code") ?? "";
	const t = await token(
		issuer,
		{ grant_type: "authorization_code", code, redirect_uri: s.redirect, code_verifier: p.verifier },
		{ id: s.id, secret: s.secret },
	);
	expect(t.status).toBe(200);
	return {
		...s,
		code,
		verifier: p.verifier,
		access: String(t.data["access_token"]),
		refresh: String(t.data["refresh_token"]),
		body: t.data,
	};
}

async function expectErrorPage(res: Response): Promise<void> {
	expect(res.status).toBe(400);
	expect(res.headers.get("location")).toBeNull();
	expect(res.headers.get("content-type")).toMatch(/^text\/html/);
	expect(await res.text()).toContain("This request is not valid");
}

const S256 = () => {
	const p = pkce();
	return { code_challenge: p.challenge, code_challenge_method: "S256" };
};

async function register(body: Record<string, unknown>) {
	const res = await fetch(`${issuer.origin}/oauth/reg`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const dcrClaude = {
	redirect_uris: [CLAUDE_REDIRECT],
	client_name: "Claude",
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
	application_type: "web",
};

// ---- 1–6: discovery and protocol basics (also run against prod) ----

describe("discovery", () => {
	test("1. unauthenticated /mcp: 401 with the resource metadata challenge", async () => {
		const res = await callMcp(issuer, undefined);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${issuer.origin}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"`,
		);
	});

	test("2. PRM resource is the MCP URL exactly; one authorization server", async () => {
		const prm = (await (await fetch(`${issuer.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
			string,
			unknown
		>;
		expect(prm).toEqual({
			resource: issuer.mcpUrl,
			authorization_servers: [issuer.origin],
			scopes_supported: ["memory.read", "memory.write"],
			bearer_methods_supported: ["header"],
		});
	});

	test("3. AS metadata advertises CIMD, `none`, iss and S256 only", async () => {
		const m = (await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server`)).json()) as Record<
			string,
			unknown
		>;
		expect(m["client_id_metadata_document_supported"]).toBe(true);
		expect(m["token_endpoint_auth_methods_supported"]).toEqual(["none", "client_secret_post", "client_secret_basic"]);
		expect(m["authorization_response_iss_parameter_supported"]).toBe(true);
		expect(m["code_challenge_methods_supported"]).toEqual(["S256"]);
		expect(m["response_types_supported"]).toEqual(["code"]);
		expect(m["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
		expect(m["scopes_supported"]).toEqual(["memory.read", "memory.write", "memory.capture", "offline_access"]);
		for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"])
			expect(String(m[k])).toMatch(new RegExp(`^${issuer.origin}/oauth/`));
	});

	test("4. authorization responses include iss", async () => {
		const s = await staticWindow();
		const back = await authorize(issuer, owner, { client_id: s.id, redirect_uri: s.redirect, ...S256() });
		expect(back.origin + back.pathname).toBe(CLAUDE_REDIRECT);
		expect(back.searchParams.get("iss")).toBe(issuer.origin);
		expect(back.searchParams.get("state")).toBe("st-1");
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("5. /token takes form encoding; a dead refresh token is invalid_grant", async () => {
		const g = await staticGrant();
		expect(g.body["token_type"]).toBe("Bearer");
		expect(g.body["scope"]).toBe("memory.read memory.write");
		expect(g.body["expires_in"]).toBe(3600);
		const dead = await token(
			issuer,
			{ grant_type: "refresh_token", refresh_token: "not-a-real-refresh-token" },
			{ id: g.id, secret: g.secret },
		);
		expect(dead.status).toBe(400);
		expect(dead.data["error"]).toBe("invalid_grant");
		// client_secret_post works for the same static client (§4.2).
		const viaPost = await token(issuer, {
			grant_type: "refresh_token",
			refresh_token: g.refresh,
			client_id: g.id,
			client_secret: g.secret,
		});
		expect(viaPost.status).toBe(200);
	});

	localOnly(
		"6. a cold server answers discovery, registration and token within 10 s, refresh within 30 s",
		async () => {
			const t0 = performance.now();
			const cold = await startIssuer();
			try {
				const coldOwner = await ownerSetup(cold);
				const lap = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
					const s = performance.now();
					const v = await f();
					return [v, performance.now() - s];
				};
				const [, discovery] = await lap(() =>
					fetch(`${cold.origin}/.well-known/oauth-authorization-server`).then((r) => r.json()),
				);
				await openWindow(cold, coldOwner, { vendor: "claude", method: "dcr" });
				const [reg, registration] = await lap(() =>
					fetch(`${cold.origin}/oauth/reg`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(dcrClaude),
					}).then((r) => r.json() as Promise<Record<string, string>>),
				);
				const p = pkce();
				const back = await authorize(cold, coldOwner, {
					client_id: reg["client_id"] ?? "",
					redirect_uri: CLAUDE_REDIRECT,
					code_challenge: p.challenge,
					code_challenge_method: "S256",
				});
				const [t, tokenMs] = await lap(() =>
					token(cold, {
						grant_type: "authorization_code",
						code: back.searchParams.get("code") ?? "",
						redirect_uri: CLAUDE_REDIRECT,
						code_verifier: p.verifier,
						client_id: reg["client_id"] ?? "",
					}),
				);
				const [r, refreshMs] = await lap(() =>
					token(cold, {
						grant_type: "refresh_token",
						refresh_token: String(t.data["refresh_token"]),
						client_id: reg["client_id"] ?? "",
					}),
				);
				expect(t.status).toBe(200);
				expect(r.status).toBe(200);
				console.log(
					JSON.stringify({
						test: 6,
						startMs: Math.round(performance.now() - t0),
						discoveryMs: Math.round(discovery),
						registrationMs: Math.round(registration),
						tokenMs: Math.round(tokenMs),
						refreshMs: Math.round(refreshMs),
					}),
				);
				expect(Math.max(discovery, registration, tokenMs)).toBeLessThan(10_000);
				expect(refreshMs).toBeLessThan(30_000);
			} finally {
				await cold.stop();
			}
		},
		timeout(60_000),
	);

	deployedOnly(
		"6. the deployed stage answers discovery, registration and token within 10 s, refresh within 30 s",
		async () => {
			const lap = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
				const s = performance.now();
				const v = await f();
				return [v, performance.now() - s];
			};
			const [, discovery] = await lap(() =>
				fetch(`${issuer.origin}/.well-known/oauth-authorization-server`).then((r) => r.json()),
			);
			await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
			const [reg, registration] = await lap(() => register(dcrClaude));
			const clientId = String(reg.data["client_id"]);
			const p = pkce();
			const back = await authorize(issuer, owner, {
				client_id: clientId,
				redirect_uri: CLAUDE_REDIRECT,
				code_challenge: p.challenge,
				code_challenge_method: "S256",
			});
			const [t, tokenMs] = await lap(() =>
				token(issuer, {
					grant_type: "authorization_code",
					code: back.searchParams.get("code") ?? "",
					redirect_uri: CLAUDE_REDIRECT,
					code_verifier: p.verifier,
					client_id: clientId,
				}),
			);
			const [r, refreshMs] = await lap(() =>
				token(issuer, {
					grant_type: "refresh_token",
					refresh_token: String(t.data["refresh_token"]),
					client_id: clientId,
				}),
			);
			expect([reg.status, t.status, r.status]).toEqual([201, 200, 200]);
			console.log(
				JSON.stringify({
					test: 6,
					discoveryMs: Math.round(discovery),
					registrationMs: Math.round(registration),
					tokenMs: Math.round(tokenMs),
					refreshMs: Math.round(refreshMs),
				}),
			);
			expect(Math.max(discovery, registration, tokenMs)).toBeLessThan(10_000);
			expect(refreshMs).toBeLessThan(30_000);
		},
	);
});

// ---- 7–14: clients, redirects and codes ----

describe("clients", () => {
	test("7. the PC client's loopback redirect matches any port on localhost and 127.0.0.1", async () => {
		for (const redirect of ["http://127.0.0.1:53111/callback", "http://localhost:61002/callback"]) {
			const w = await openWindow(issuer, owner, { vendor: "pc", method: "static" });
			expect(w.credentials).toBeUndefined();
			const p = pkce();
			const back = await authorize(issuer, owner, {
				client_id: "memory-anywhere-cli",
				redirect_uri: redirect,
				code_challenge: p.challenge,
				code_challenge_method: "S256",
				scope: "memory.read memory.write memory.capture offline_access",
			});
			expect(`${back.origin}${back.pathname}`).toBe(redirect);
			const t = await token(issuer, {
				grant_type: "authorization_code",
				code: back.searchParams.get("code") ?? "",
				redirect_uri: redirect,
				code_verifier: p.verifier,
				client_id: "memory-anywhere-cli",
			});
			expect(t.status).toBe(200);
			expect(t.data["scope"]).toBe("memory.read memory.write memory.capture");
		}
		// Other paths do not match, and non-loopback clients never get port leniency.
		await openWindow(issuer, owner, { vendor: "pc", method: "static" });
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, { client_id: "memory-anywhere-cli", redirect_uri: "http://127.0.0.1:53111/other", ...S256() }),
			),
		);
		const s = await staticWindow();
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, { client_id: s.id, redirect_uri: "https://claude.ai:8443/api/mcp/auth_callback", ...S256() }),
			),
		);
	});

	test("8a. static clients: authorize inside their window only", async () => {
		const s = await staticWindow("chatgpt");
		expect(s.redirect).toBe(CHATGPT_REDIRECT);
		await authorize(issuer, owner, { client_id: s.id, redirect_uri: s.redirect, ...S256() }); // closes the window
		await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256() })));
	});

	test("8b. DCR: the vendor's exact redirect registers inside a window, never outside; a foreign redirect closes it", async () => {
		expect((await register(dcrClaude)).status).toBe(400); // no window
		await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
		const reg = await register(dcrClaude);
		expect(reg.status).toBe(201);
		expect(await register(dcrClaude)).toEqual({ status: 400, data: { error: "invalid_request" } }); // one registration per window
		const p = pkce();
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: String(reg.data["client_id"]),
					redirect_uri: CLAUDE_REDIRECT,
					code_challenge: p.challenge,
					code_challenge_method: "S256",
				}),
			),
		); // the race closed the window

		const w = await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
		expect((await register({ ...dcrClaude, redirect_uris: ["https://evil.example/callback"] })).status).toBe(400);
		if (local) expect(local.pairing.get(w.window_id)?.close_reason).toBe("registration_race");
		expect((await register({ ...dcrClaude, redirect_uris: [CHATGPT_REDIRECT] })).status).toBe(400); // the window is closed
		await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
		expect((await register(dcrClaude)).status).toBe(400); // claude.ai is not a ChatGPT redirect host

		await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
		const ok = await register({ ...dcrClaude, redirect_uris: [CHATGPT_REDIRECT] });
		expect(ok.status).toBe(201);
		const back = await authorize(issuer, owner, {
			client_id: String(ok.data["client_id"]),
			redirect_uri: CHATGPT_REDIRECT,
			...S256(),
		});
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("8e. DCR as Grok sends it (no application_type) registers inside a Grok window", async () => {
		const grok = {
			client_name: "Grok",
			redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
		expect((await register(grok)).status).toBe(400);
		await openWindow(issuer, owner, { vendor: "grok", method: "dcr" });
		const reg = await register(grok);
		expect(reg.status).toBe(201);
		const back = await authorize(issuer, owner, {
			client_id: String(reg.data["client_id"]),
			redirect_uri: grok.redirect_uris[0] ?? "",
			...S256(),
		});
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("8e2. a registration naming its scope registers; one with an unknown field is refused and names the field", async () => {
		const grok = {
			client_name: "Grok",
			redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
		const refused = () =>
			local?.app.alerts
				.open()
				.filter((a) => a.kind === "registration_refused")
				.map((a) => a.subject) ?? [];
		expect((await register({ ...grok, logo_uri: "https://grok.com/logo.png" })).status).toBe(400); // no window: nothing raised
		expect(refused()).toEqual([]);
		await openWindow(issuer, owner, { vendor: "grok", method: "dcr" });
		expect(
			(await register({ ...grok, logo_uri: "https://grok.com/logo.png", jwks_uri: "https://grok.com/jwks" })).status,
		).toBe(400);
		expect((await register({ ...grok, scope: "memory.read admin" })).status).toBe(400);
		if (local) expect(refused().sort()).toEqual(["grok:logo_uri:jwks_uri", "grok:scope"]);
		// Refusals leave the window's one registration for the real request, which may name its scope.
		const reg = await register({ ...grok, scope: "openid memory.read memory.write offline_access" });
		expect(reg.status).toBe(201);
		expect(reg.data["scope"]).toBeUndefined(); // ignored: the client's policy sets its scopes
		const back = await authorize(issuer, owner, {
			client_id: String(reg.data["client_id"]),
			redirect_uri: grok.redirect_uris[0] ?? "",
			...S256(),
		});
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("8f. a request with the openid scope (as Grok sends) completes after one consent", async () => {
		const s = await staticWindow("chatgpt");
		const back = await authorize(issuer, owner, {
			client_id: s.id,
			redirect_uri: s.redirect,
			scope: "openid memory.read memory.write offline_access",
			...S256(),
		});
		expect(`${back.origin}${back.pathname}`).toBe(s.redirect);
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("8g. a vendor asking for every advertised scope (as Grok does) gets read and write after one consent", async () => {
		const s = await staticWindow("chatgpt");
		const p = pkce();
		const back = await authorize(issuer, owner, {
			client_id: s.id,
			redirect_uri: s.redirect,
			scope: "memory.read memory.write memory.capture",
			code_challenge: p.challenge,
			code_challenge_method: "S256",
		});
		expect(`${back.origin}${back.pathname}`).toBe(s.redirect);
		const t = await token(
			issuer,
			{
				grant_type: "authorization_code",
				code: back.searchParams.get("code") ?? "",
				redirect_uri: s.redirect,
				code_verifier: p.verifier,
			},
			{ id: s.id, secret: s.secret },
		);
		expect(t.data["scope"]).toBe("memory.read memory.write");
	});

	localOnly("8c. CIMD: the vendor's document works inside its window only, with its exact redirect", async () => {
		documents.set(CHATGPT_CIMD, cimdDoc(CHATGPT_CIMD, [CHATGPT_REDIRECT]));
		await expectErrorPage(
			await owner.fetch(authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT, ...S256() })),
		); // no window
		await openWindow(issuer, owner, { vendor: "claude_code_direct", method: "cimd" });
		await expectErrorPage(
			await owner.fetch(authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT, ...S256() })),
		); // another vendor's window
		expect(fetched).not.toContain(CHATGPT_CIMD);

		await openWindow(issuer, owner, { vendor: "chatgpt", method: "cimd" });
		const p = pkce();
		const back = await authorize(issuer, owner, {
			client_id: CHATGPT_CIMD,
			redirect_uri: CHATGPT_REDIRECT,
			code_challenge: p.challenge,
			code_challenge_method: "S256",
		});
		const t = await token(issuer, {
			grant_type: "authorization_code",
			code: back.searchParams.get("code") ?? "",
			redirect_uri: CHATGPT_REDIRECT,
			code_verifier: p.verifier,
			client_id: CHATGPT_CIMD,
		});
		expect(t.status).toBe(200);
		expect((await callMcp(issuer, String(t.data["access_token"]))).status).toBe(200);

		// A document listing a foreign redirect is refused, even for the request's own redirect.
		const foreign = "https://chatgpt.com/oauth/foreign/client.json";
		documents.set(foreign, cimdDoc(foreign, [CHATGPT_REDIRECT, "https://evil.example/cb"]));
		await openWindow(issuer, owner, { vendor: "chatgpt", method: "cimd" });
		await expectErrorPage(
			await owner.fetch(authUrl(issuer, { client_id: foreign, redirect_uri: CHATGPT_REDIRECT, ...S256() })),
		);
	});

	localOnly("8d. Claude Code (direct): CIMD with a loopback redirect on any port", async () => {
		documents.set(
			CLAUDE_CODE_CIMD,
			cimdDoc(CLAUDE_CODE_CIMD, ["http://localhost/callback"], {
				application_type: "native",
				client_name: "Claude Code",
			}),
		);
		await openWindow(issuer, owner, { vendor: "claude_code_direct", method: "cimd" });
		const back = await authorize(issuer, owner, {
			client_id: CLAUDE_CODE_CIMD,
			redirect_uri: "http://localhost:49152/callback",
			...S256(),
		});
		expect(back.searchParams.get("code")).toBeTruthy();
	});

	test("9. PKCE plain and a missing challenge are refused with the error page", async () => {
		const s = await staticWindow();
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: s.id,
					redirect_uri: s.redirect,
					code_challenge: pkce().verifier,
					code_challenge_method: "plain",
				}),
			),
		);
		await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect })));
	});

	test("10. reusing an authorization code fails and revokes what it issued", async () => {
		const g = await staticGrant();
		expect((await callMcp(issuer, g.access)).status).toBe(200);
		const again = await token(
			issuer,
			{ grant_type: "authorization_code", code: g.code, redirect_uri: g.redirect, code_verifier: g.verifier },
			{ id: g.id, secret: g.secret },
		);
		expect(again.status).toBe(400);
		expect(again.data["error"]).toBe("invalid_grant");
		expect((await callMcp(issuer, g.access)).status).toBe(401);
		expect(
			(await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, { id: g.id, secret: g.secret }))
				.data["error"],
		).toBe("invalid_grant");
	});

	test("11. refresh reuse within 30 s returns the same pair; after 30 s it revokes the grant", async () => {
		const g = await staticGrant();
		const auth = { id: g.id, secret: g.secret };
		const first = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
		expect(first.status).toBe(200);
		expect(first.data["refresh_token"]).not.toBe(g.refresh); // rotated
		await elapse(local ? 29_000 : 20_000); // deployed, the requests themselves take time inside the 30 s
		const concurrent = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
		expect(concurrent.data).toEqual(first.data);
		await elapse(local ? 2_000 : 12_000);
		const late = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
		expect(late.data["error"]).toBe("invalid_grant");
		expect(
			(await token(issuer, { grant_type: "refresh_token", refresh_token: String(first.data["refresh_token"]) }, auth))
				.data["error"],
		).toBe("invalid_grant");
		expect((await callMcp(issuer, String(first.data["access_token"]))).status).toBe(401);
	});

	localOnly(
		"11c. without offline_access (as ChatGPT asks) the grant outlives the owner's consent session",
		async () => {
			const s = await staticWindow("chatgpt");
			const p = pkce();
			const back = await authorize(issuer, owner, {
				client_id: s.id,
				redirect_uri: s.redirect,
				code_challenge: p.challenge,
				code_challenge_method: "S256",
				scope: "memory.read memory.write",
			});
			const auth = { id: s.id, secret: s.secret };
			const t = await token(
				issuer,
				{
					grant_type: "authorization_code",
					code: back.searchParams.get("code") ?? "",
					redirect_uri: s.redirect,
					code_verifier: p.verifier,
				},
				auth,
			);
			expect(t.data["refresh_token"]).toBeTruthy();
			// The owner's browser session at the authorization server ends (10 minutes in production).
			local?.db.prepare("DELETE FROM oidc_store WHERE model = 'Session'").run();
			expect((await callMcp(issuer, String(t.data["access_token"]))).status).toBe(200);
			const r = await token(
				issuer,
				{ grant_type: "refresh_token", refresh_token: String(t.data["refresh_token"]) },
				auth,
			);
			expect(r.status).toBe(200);
			expect((await callMcp(issuer, String(r.data["access_token"]))).status).toBe(200);
		},
	);

	test("11b. Gemini: its per-user redirect is matched by rule and pinned, and its refresh token is fixed (§4.5, §5.3)", async () => {
		// A Gemini redirect embeds the user's Google id and this server's host.
		const geminiRedirect = `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456-${new URL(issuer.origin).hostname.replaceAll(".", "_")}`;
		const s = await staticWindow("gemini");
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: s.id,
					redirect_uri: "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123456-elsewhere_example",
					...S256(),
				}),
			),
		);
		const p = pkce();
		const back = await authorize(issuer, owner, {
			client_id: s.id,
			redirect_uri: geminiRedirect,
			code_challenge: p.challenge,
			code_challenge_method: "S256",
		});
		const auth = { id: s.id, secret: s.secret };
		const t0 = await token(
			issuer,
			{
				grant_type: "authorization_code",
				code: back.searchParams.get("code") ?? "",
				redirect_uri: geminiRedirect,
				code_verifier: p.verifier,
			},
			auth,
		);
		expect(t0.status).toBe(200);
		const g = { refresh: String(t0.data["refresh_token"]) };
		const a = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
		await elapse(60_000);
		const b = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(a.data["refresh_token"]).toBe(g.refresh);
		expect(b.data["access_token"]).not.toBe(a.data["access_token"]);
	});

	test("11c. Gemini's current redirect, an opaque hex id with no host, is accepted and then pinned", async () => {
		const google = "https://oauth-redirect.googleusercontent.com/r/";
		const geminiRedirect = `${google}user_bound_custom-mcp-194f805ad1aa24097bdad1b0`;
		const s = await staticWindow("gemini");
		for (const bad of [
			"194F805AD1AA24097BDAD1B0",
			"194f805ad1aa24097bdad1b0/x",
			"194f805a",
			"zz4f805ad1aa24097bdad1b0",
		]) {
			await expectErrorPage(
				await owner.fetch(
					authUrl(issuer, { client_id: s.id, redirect_uri: `${google}user_bound_custom-mcp-${bad}`, ...S256() }),
				),
			);
		}
		const p = pkce();
		const back = await authorize(issuer, owner, {
			client_id: s.id,
			redirect_uri: geminiRedirect,
			code_challenge: p.challenge,
			code_challenge_method: "S256",
		});
		expect(`${back.origin}${back.pathname}`).toBe(geminiRedirect);
		// The first accepted redirect is now the client's only one.
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: s.id,
					redirect_uri: `${google}user_bound_custom-mcp-0123456789abcdef01234567`,
					...S256(),
				}),
			),
		);
	});

	test("12. an invalid redirect_uri or client_id yields the error page, not a redirect", async () => {
		const s = await staticWindow();
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, { client_id: s.id, redirect_uri: "https://claude.ai/api/mcp/other", ...S256() }),
			),
		);
		await expectErrorPage(
			await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: `${CLAUDE_REDIRECT}/`, ...S256() })),
		);
		await expectErrorPage(
			await owner.fetch(authUrl(issuer, { client_id: "ma_unknown", redirect_uri: s.redirect, ...S256() })),
		);
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256(), response_mode: "form_post" }),
			),
		);
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: s.id,
					redirect_uri: s.redirect,
					...S256(),
					resource: "https://elsewhere.example/mcp",
				}),
			),
		);
	});

	test("13. CIMD URL shapes and targets outside the rules are refused", async () => {
		await openWindow(issuer, owner, { vendor: "chatgpt", method: "cimd" });
		const shapes = [
			"https://user@chatgpt.com/oauth/client.json",
			"https://chatgpt.com:443/oauth/client.json",
			"https://chatgpt.com:8443/oauth/client.json",
			"https://chatgpt.com/oauth/client.json?x=1",
			"https://chatgpt.com/oauth/client.json#f",
			"https://chatgpt.com.evil.example/oauth/client.json",
			"https://evilchatgpt.com/oauth/client.json",
			"https://chatgpt.com/oauth/../oauth/client.json",
			"http://chatgpt.com/oauth/client.json",
		];
		const before = fetched.length;
		for (const id of shapes)
			await expectErrorPage(
				await owner.fetch(authUrl(issuer, { client_id: id, redirect_uri: CHATGPT_REDIRECT, ...S256() })),
			);
		expect(fetched.length).toBe(before); // none of them was fetched
		if (!local) return; // the redirecting and private-address targets are served by this test's network
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: "https://chatgpt.com/oauth/redirecting/client.json",
					redirect_uri: CHATGPT_REDIRECT,
					...S256(),
				}),
			),
		);
		await expectErrorPage(
			await owner.fetch(
				authUrl(issuer, {
					client_id: "https://chatgpt.com/oauth/private/client.json",
					redirect_uri: CHATGPT_REDIRECT,
					...S256(),
				}),
			),
		);
		expect(fetched).toContain("https://chatgpt.com/oauth/private/client.json");
		expect(docHits).toBe(0); // the private-address server was never reached
	});

	test("14. DCR fields outside the allow-list are refused; RFC 7592 endpoints are 404", async () => {
		for (const extra of [
			{ jwks_uri: "https://claude.ai/jwks" },
			{ logo_uri: "https://claude.ai/logo.png" },
			{ sector_identifier_uri: "https://claude.ai/s" },
			{ request_uris: [] },
			{ scope: "memory.admin" },
		]) {
			const w = await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
			expect(await register({ ...dcrClaude, ...extra })).toEqual({ status: 400, data: { error: "invalid_request" } });
			if (local) expect(local.pairing.get(w.window_id)?.registration_used).toBe(0);
		}
		for (const bad of [
			{ application_type: "native" },
			{ application_type: "browser" },
			{ grant_types: ["client_credentials"] },
			{ response_types: ["token"] },
			{ client_name: "x".repeat(65) },
			{ redirect_uris: [CLAUDE_REDIRECT, CLAUDE_REDIRECT, CLAUDE_REDIRECT] },
		]) {
			await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
			expect((await register({ ...dcrClaude, ...bad })).status).toBe(400);
		}
		await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
		const reg = await register(dcrClaude);
		expect(reg.status).toBe(201);
		expect(reg.data["registration_access_token"]).toBeUndefined();
		expect(reg.data["registration_client_uri"]).toBeUndefined();
		for (const method of ["GET", "PUT", "DELETE"]) {
			expect((await fetch(`${issuer.origin}/oauth/reg/${String(reg.data["client_id"])}`, { method })).status).toBe(404);
		}
	});
});

// ---- 15–20: surfaces and owner binding ----

describe("surfaces", () => {
	test(
		"15. route inventory: nothing outside routes.allow.txt answers on {host}",
		async () => {
			const { unlisted, silent } = await routeInventory(issuer.origin, "mcp");
			expect(unlisted).toEqual([]);
			expect(silent).toEqual([]);
		},
		timeout(60_000),
	);

	test(
		"15b. route inventory: nothing outside routes.admin.allow.txt answers on admin.{host}",
		async () => {
			const { unlisted, silent } = await routeInventory(issuer.adminOrigin, "admin");
			expect(unlisted).toEqual([]);
			expect(silent).toEqual([]);
		},
		timeout(60_000),
	);

	test("16. /mcp ignores cookies and rejects a browser Origin", async () => {
		const g = await staticGrant();
		const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join("; ");
		expect((await callMcp(issuer, undefined, { cookie })).status).toBe(401);
		expect((await callMcp(issuer, g.access, { cookie })).status).toBe(200);
		expect((await callMcp(issuer, g.access, { origin: "https://evil.example" })).status).toBe(403);
		expect((await callMcp(issuer, g.access, { origin: issuer.origin })).status).toBe(403);
		expect((await callMcp(issuer, g.access, { origin: "null" })).status).toBe(200);
		const cors = await fetch(issuer.mcpUrl, {
			method: "OPTIONS",
			headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
		});
		expect(cors.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("17. both discovery paths return the same metadata with the host's issuer", async () => {
		const a = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server`)).json();
		const b = await (await fetch(`${issuer.origin}/.well-known/openid-configuration`)).json();
		expect(a).toEqual(b);
		expect((a as Record<string, unknown>)["issuer"]).toBe(issuer.origin);
	});

	test("18. failures on reg, auth and token are byte-identical with and without an open window", async () => {
		const snapshot = async (path: string, init: RequestInit) => {
			const res = await fetch(`${issuer.origin}${path}`, { ...init, redirect: "manual" });
			const headers = [...res.headers].filter(([k]) => k !== "date" && k !== "keep-alive" && k !== "connection").sort();
			return JSON.stringify({ status: res.status, headers, body: await res.text() });
		};
		const json = { "content-type": "application/json" };
		const probes: [string, RequestInit][] = [
			["/oauth/reg", { method: "POST", headers: json, body: JSON.stringify(dcrClaude) }],
			[
				"/oauth/reg",
				{ method: "POST", headers: json, body: JSON.stringify({ ...dcrClaude, jwks_uri: "https://claude.ai/j" }) },
			],
			["/oauth/reg", { method: "POST", headers: json, body: "not json" }],
			["/oauth/reg", { method: "GET" }],
			[authUrl(issuer, { client_id: "ma_unknown", redirect_uri: CLAUDE_REDIRECT, ...S256() }), { method: "GET" }],
			[authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT }), { method: "GET" }],
			["/oauth/auth", { method: "GET" }],
			[
				"/oauth/token",
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "grant_type=authorization_code&code=x&client_id=ma_unknown",
				},
			],
			[
				"/oauth/token",
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "grant_type=refresh_token&refresh_token=x&client_id=memory-anywhere-cli",
				},
			],
		];
		await elapse(11 * 60_000); // let every window expire
		const closed = [];
		for (const [p, i] of probes) closed.push(await snapshot(p, i));
		for (const vendor of [
			["claude", "dcr"],
			["chatgpt", "cimd"],
			["pc", "static"],
		] as const) {
			await openWindow(issuer, owner, { vendor: vendor[0], method: vendor[1] });
			const open = [];
			for (const [p, i] of probes) {
				if (vendor[1] === "dcr" && p === "/oauth/reg" && i.body === JSON.stringify(dcrClaude)) {
					open.push(closed[open.length]); // inside a claude DCR window this one is valid and registers
					continue;
				}
				open.push(await snapshot(p, i));
			}
			expect(open).toEqual(closed);
		}
		expect(closed.filter((s) => s.includes('"body":"{\\"error\\":\\"invalid_request\\"}"')).length).toBe(3);
	});

	test(
		"19. consent needs the window's pair cookie or its pair code",
		async () => {
			const s = await staticWindow();
			const phone = new Browser(issuer.origin); // the vendor flow opened in another browser
			const start = await phone.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256() }));
			const consentPath = start.headers.get("location") ?? "";
			expect(consentPath).toMatch(/^\/consent\//);
			const page = await (await phone.fetch(consentPath)).text();
			expect(page).toContain("Pairing code");
			expect(page).not.toContain("Approve");
			expect((await phone.postJson(`${consentPath}/options`)).status).toBe(403);
			expect(
				(await phone.postJson(`${consentPath}/approve`, issuer.authenticator.get({ challenge: "x" }))).status,
			).toBe(403);
			expect((await phone.postJson(`${consentPath}/code`, { code: "AAAAAAAA" })).status).toBe(403);
			expect((await phone.postJson(`${consentPath}/code`, { code: s.w.pair_code.toLowerCase() })).status).toBe(200);
			expect(await (await phone.fetch(consentPath)).text()).toContain("Approve with passkey");
			const options = await phone.postJson(`${consentPath}/options`);
			const approved = await phone.postJson(`${consentPath}/approve`, issuer.authenticator.get(options.data as never));
			expect(approved.status).toBe(200);
			// Cross-site posts are refused even with the cookie.
			const w2 = await staticWindow();
			const start2 = await owner.fetch(authUrl(issuer, { client_id: w2.id, redirect_uri: w2.redirect, ...S256() }));
			const path2 = start2.headers.get("location") ?? "";
			const cross = await owner.fetch(`${path2}/options`, {
				method: "POST",
				body: "{}",
				headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
			});
			expect(cross.status).toBe(403);
			// Five wrong codes close the window.
			const w3 = await staticWindow();
			const other = new Browser(issuer.origin);
			const path3 =
				(await other.fetch(authUrl(issuer, { client_id: w3.id, redirect_uri: w3.redirect, ...S256() }))).headers.get(
					"location",
				) ?? "";
			await other.fetch(path3); // the code form, and its CSRF token
			for (let i = 0; i < 5; i++) await other.postJson(`${path3}/code`, { code: "BBBBBBBB" });
			if (local) expect(local.pairing.get(w3.w.window_id)?.close_reason).toBe("code_attempts");
			expect((await other.postJson(`${path3}/code`, { code: w3.w.pair_code })).status).toBe(400); // closed: even the right code fails
		},
		timeout(20_000),
	); // several round trips; slow on Windows runners

	localOnly(
		"20. MRTR requestState: tampered, expired, replayed, other-grant or other-argument state falls back",
		() => {
			if (!local) throw new Error("local only");
			const ctx = local.app.ctx;
			const digest = argsDigest("memory_save", { content: "Prefers tea" });
			const fresh = () => startElicitation(ctx, "grant-a", "memory_save", digest, "Apply this preference?");
			expect(consumeElicitation(ctx, fresh(), "grant-a", digest)).toBe(true);
			const raw = Buffer.from(fresh(), "base64url");
			raw[20] = (raw[20] ?? 0) ^ 1; // one flipped bit inside the ciphertext
			expect(consumeElicitation(ctx, raw.toString("base64url"), "grant-a", digest)).toBe(false);
			expect(consumeElicitation(ctx, "garbage", "grant-a", digest)).toBe(false);
			expect(consumeElicitation(ctx, fresh(), "grant-b", digest)).toBe(false);
			expect(
				consumeElicitation(ctx, fresh(), "grant-a", argsDigest("memory_save", { content: "Prefers coffee" })),
			).toBe(false);
			const replay = fresh();
			expect(consumeElicitation(ctx, replay, "grant-a", digest)).toBe(true);
			expect(consumeElicitation(ctx, replay, "grant-a", digest)).toBe(false);
			const old = fresh();
			local.clock.advance(5 * 60_000 + 1);
			expect(consumeElicitation(ctx, old, "grant-a", digest)).toBe(false);
		},
	);

	test("20b. MRTR through /mcp: only a fresh, untampered state for this grant and these arguments is an answer", async () => {
		const claude = await staticGrant("claude");
		await confirmClaudeSaves();
		const tier = (r: Record<string, unknown>): string | undefined =>
			(r["structuredContent"] as { tier?: string } | undefined)?.tier;
		const ask = async (args: Record<string, unknown>, access = claude.access): Promise<string> => {
			const asked = await mcpSave(access, args);
			expect(JSON.stringify(asked)).toContain("Apply this preference in all your AI apps");
			return String(asked["requestState"]);
		};
		const answer = (args: Record<string, unknown>, requestState: string, access = claude.access) =>
			mcpSave(access, args, {
				inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
				requestState,
			});

		// Each check uses its own preference: a fallback stores it (T2), and a stored fact is not asked again.
		const flipped = Buffer.from(await ask(PREFERENCES[0]), "base64url");
		flipped[20] = (flipped[20] ?? 0) ^ 1; // one flipped bit inside the ciphertext
		expect(tier(await answer(PREFERENCES[0], flipped.toString("base64url")))).not.toBe("T1");
		expect(tier(await answer(PREFERENCES[1], "garbage"))).not.toBe("T1");
		expect(tier(await answer(PREFERENCES[3], await ask(PREFERENCES[2])))).not.toBe("T1"); // other arguments

		const once = await ask(PREFERENCES[4]);
		expect(tier(await answer(PREFERENCES[4], once))).toBe("T1"); // the real answer is an answer
		expect(tier(await answer(PREFERENCES[5], once))).not.toBe("T1"); // replayed

		const old = await ask(PREFERENCES[6]);
		await elapse(5 * 60_000 + 1_000);
		expect(tier(await answer(PREFERENCES[6], old))).not.toBe("T1"); // expired

		// Another grant (pairing Claude again replaces this one) cannot use this grant's state.
		const mine = await ask(PREFERENCES[7]);
		const next = await staticGrant("claude");
		await confirmClaudeSaves();
		expect(tier(await answer(PREFERENCES[7], mine, next.access))).not.toBe("T1");
	});
});

// ---- 20b helpers: an owner action, and memory_save on the 2026-07-28 revision ----

/** Preferences that ask the person (no explicit request); each assertion uses its own fact. */
const PREFERENCES = [
	"short answers to quick questions",
	"long answers to quick questions",
	"metric units",
	"imperial units",
	"dark mode in every app",
	"a light theme in every app",
	"trains over planes",
	"window seats on trains",
].map((p): Record<string, unknown> => ({
	content: `Prefers ${p}`,
	kind: "preference",
	why_durable: "how to answer",
	user_words: `I prefer ${p}`,
	explicit_request: false,
})) as unknown as Record<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, Record<string, unknown>>;

/** As the owner on the Apps page: every connected Claude app confirms saves with a question. */
async function confirmClaudeSaves(): Promise<void> {
	const html = await (await owner.fetch(`${issuer.adminOrigin}/apps`)).text();
	const ids = [
		...html.matchAll(
			/<h2>Claude <span[^]*?data-action="client\.policy">\s*<input type="hidden" name="client_id" value="(cli_\w+)">/gu,
		),
	].map((m) => m[1] ?? "");
	expect(ids.length).toBeGreaterThan(0);
	for (const client_id of ids)
		await act("client.policy", {
			client_id,
			write: true,
			sections: "all",
			save_floor: "none",
			elicitation: "verified",
		});
}

/** One owner action through the admin API, with a passkey step-up when it asks for one (§3.4). */
async function act(action: string, input: Record<string, unknown>): Promise<void> {
	const url = `${issuer.adminOrigin}/api/act/${action}`;
	let r = await owner.postJson(url, { input });
	if (r.data["error"] === "step_up_required") {
		const options = await owner.postJson(`${issuer.adminOrigin}/api/stepup/options`);
		await owner.postJson(`${issuer.adminOrigin}/api/stepup/verify`, issuer.authenticator.get(options.data as never));
		r = await owner.postJson(url, { input });
	}
	if (r.status !== 200) throw new Error(`${action}: ${JSON.stringify(r)}`);
}

async function mcpSave(
	access: string,
	args: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const envelope = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
	};
	const res = await fetch(issuer.mcpUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${access}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/call",
			"mcp-name": "memory_save",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { _meta: envelope, name: "memory_save", arguments: args, ...extra },
		}),
	});
	const text = await res.text();
	const json = text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}");
	const body = JSON.parse(json) as { result?: Record<string, unknown> };
	if (!body.result) throw new Error(`tools/call: ${res.status} ${text}`);
	return body.result;
}
