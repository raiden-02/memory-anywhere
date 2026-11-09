// OAuth conformance tests 1–20 (m0-spike.md §5) against a local issuer. Each test names the rule it
// checks in auth-and-security.md. Tests share one issuer and run in order: a pairing window is
// server-wide state, exactly as in production.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RequestStates } from "../../../../spikes/oauth-oidc-provider/src/mrtr.ts";
import { routeInventory } from "./routes.ts";
import { authorize, authUrl, Browser, callMcp, openWindow, ownerSetup, pkce, startIssuer, token, type Issuer } from "./issuer.ts";

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
  return { client_id: clientId, client_name: "Test vendor", redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...extra };
}

const network = async (url: string | URL, options: RequestInit): Promise<Response> => {
  const id = String(url);
  fetched.push(id);
  if (id.includes("/private/")) return fetch(privateTarget, options); // keeps the library's SSRF dispatcher
  if (id.includes("/redirecting/")) return new Response(null, { status: 302, headers: { location: CHATGPT_CIMD } });
  const doc = documents.get(id);
  return doc ? new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 });
};

let issuer: Issuer;
let owner: Browser;
let docServer: Server;
let docHits = 0;

beforeAll(async () => {
  // A server on a private address that would serve a valid document if the fetch reached it.
  docServer = createServer((_req, res) => {
    docHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(cimdDoc("https://chatgpt.com/oauth/private/client.json", [CHATGPT_REDIRECT])));
  });
  await new Promise<void>((r) => docServer.listen(0, "127.0.0.1", r));
  privateTarget = `http://127.0.0.1:${(docServer.address() as AddressInfo).port}/client.json`;
  issuer = await startIssuer({ fetch: network as never });
  owner = await ownerSetup(issuer);
});

afterAll(async () => {
  await issuer?.stop();
  await new Promise<void>((r) => docServer.close(() => r()));
});

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
  const back = await authorize(issuer, owner, { client_id: s.id, redirect_uri: s.redirect, code_challenge: p.challenge, code_challenge_method: "S256" });
  const code = back.searchParams.get("code") ?? "";
  const t = await token(issuer, { grant_type: "authorization_code", code, redirect_uri: s.redirect, code_verifier: p.verifier }, { id: s.id, secret: s.secret });
  expect(t.status).toBe(200);
  return { ...s, code, verifier: p.verifier, access: String(t.data["access_token"]), refresh: String(t.data["refresh_token"]), body: t.data };
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
  const res = await fetch(`${issuer.origin}/oauth/reg`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const dcrClaude = { redirect_uris: [CLAUDE_REDIRECT], client_name: "Claude", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" };

// ---- 1–6: discovery and protocol basics (also run against prod) ----

describe("discovery", () => {
  test("1. unauthenticated /mcp: 401 with the resource metadata challenge", async () => {
    const res = await callMcp(issuer, undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${issuer.origin}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"`);
  });

  test("2. PRM resource is the MCP URL exactly; one authorization server", async () => {
    const prm = (await (await fetch(`${issuer.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toEqual({ resource: issuer.mcpUrl, authorization_servers: [issuer.origin], scopes_supported: ["memory.read", "memory.write"], bearer_methods_supported: ["header"] });
  });

  test("3. AS metadata advertises CIMD, `none`, iss and S256 only", async () => {
    const m = (await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(m["client_id_metadata_document_supported"]).toBe(true);
    expect(m["token_endpoint_auth_methods_supported"]).toEqual(["none", "client_secret_post", "client_secret_basic"]);
    expect(m["authorization_response_iss_parameter_supported"]).toBe(true);
    expect(m["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(m["response_types_supported"]).toEqual(["code"]);
    expect(m["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
    expect(m["scopes_supported"]).toEqual(["memory.read", "memory.write", "memory.capture", "offline_access"]);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) expect(String(m[k])).toMatch(new RegExp(`^${issuer.origin}/oauth/`));
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
    const dead = await token(issuer, { grant_type: "refresh_token", refresh_token: "not-a-real-refresh-token" }, { id: g.id, secret: g.secret });
    expect(dead.status).toBe(400);
    expect(dead.data["error"]).toBe("invalid_grant");
    // client_secret_post works for the same static client (§4.2).
    const viaPost = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.id, client_secret: g.secret });
    expect(viaPost.status).toBe(200);
  });

  test("6. a cold server answers discovery, registration and token within 10 s, refresh within 30 s", async () => {
    const t0 = performance.now();
    const cold = await startIssuer();
    try {
      const coldOwner = await ownerSetup(cold);
      const lap = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
        const s = performance.now();
        const v = await f();
        return [v, performance.now() - s];
      };
      const [, discovery] = await lap(() => fetch(`${cold.origin}/.well-known/oauth-authorization-server`).then((r) => r.json()));
      await openWindow(cold, coldOwner, { vendor: "claude", method: "dcr" });
      const [reg, registration] = await lap(() =>
        fetch(`${cold.origin}/oauth/reg`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dcrClaude) }).then((r) => r.json() as Promise<Record<string, string>>),
      );
      const p = pkce();
      const back = await authorize(cold, coldOwner, { client_id: reg["client_id"] ?? "", redirect_uri: CLAUDE_REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" });
      const [t, tokenMs] = await lap(() => token(cold, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: CLAUDE_REDIRECT, code_verifier: p.verifier, client_id: reg["client_id"] ?? "" }));
      const [r, refreshMs] = await lap(() => token(cold, { grant_type: "refresh_token", refresh_token: String(t.data["refresh_token"]), client_id: reg["client_id"] ?? "" }));
      expect(t.status).toBe(200);
      expect(r.status).toBe(200);
      console.log(JSON.stringify({ test: 6, startMs: Math.round(performance.now() - t0), discoveryMs: Math.round(discovery), registrationMs: Math.round(registration), tokenMs: Math.round(tokenMs), refreshMs: Math.round(refreshMs) }));
      expect(Math.max(discovery, registration, tokenMs)).toBeLessThan(10_000);
      expect(refreshMs).toBeLessThan(30_000);
    } finally {
      await cold.stop();
    }
  }, 60_000);
});

// ---- 7–14: clients, redirects and codes ----

describe("clients", () => {
  test("7. the PC client's loopback redirect matches any port on localhost and 127.0.0.1", async () => {
    for (const redirect of ["http://127.0.0.1:53111/callback", "http://localhost:61002/callback"]) {
      const w = await openWindow(issuer, owner, { vendor: "pc", method: "static" });
      expect(w.credentials).toBeUndefined();
      const p = pkce();
      const back = await authorize(issuer, owner, { client_id: "memory-anywhere-cli", redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", scope: "memory.read memory.write memory.capture offline_access" });
      expect(`${back.origin}${back.pathname}`).toBe(redirect);
      const t = await token(issuer, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: redirect, code_verifier: p.verifier, client_id: "memory-anywhere-cli" });
      expect(t.status).toBe(200);
      expect(t.data["scope"]).toBe("memory.read memory.write memory.capture");
    }
    // Other paths do not match, and non-loopback clients never get port leniency.
    await openWindow(issuer, owner, { vendor: "pc", method: "static" });
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: "memory-anywhere-cli", redirect_uri: "http://127.0.0.1:53111/other", ...S256() })));
    const s = await staticWindow();
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: "https://claude.ai:8443/api/mcp/auth_callback", ...S256() })));
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
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: String(reg.data["client_id"]), redirect_uri: CLAUDE_REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" }))); // the race closed the window

    const w = await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
    expect((await register({ ...dcrClaude, redirect_uris: ["https://evil.example/callback"] })).status).toBe(400);
    expect(issuer.pairing.get(w.window_id)?.close_reason).toBe("registration_race");
    await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
    expect((await register(dcrClaude)).status).toBe(400); // claude.ai is not a ChatGPT redirect host

    await openWindow(issuer, owner, { vendor: "chatgpt", method: "dcr" });
    const ok = await register({ ...dcrClaude, redirect_uris: [CHATGPT_REDIRECT] });
    expect(ok.status).toBe(201);
    const back = await authorize(issuer, owner, { client_id: String(ok.data["client_id"]), redirect_uri: CHATGPT_REDIRECT, ...S256() });
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  test("8e. DCR as Grok sends it (no application_type) registers inside a Grok window", async () => {
    const grok = { client_name: "Grok", redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    expect((await register(grok)).status).toBe(400);
    await openWindow(issuer, owner, { vendor: "grok", method: "dcr" });
    const reg = await register(grok);
    expect(reg.status).toBe(201);
    const back = await authorize(issuer, owner, { client_id: String(reg.data["client_id"]), redirect_uri: grok.redirect_uris[0] ?? "", ...S256() });
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  test("8c. CIMD: the vendor's document works inside its window only, with its exact redirect", async () => {
    documents.set(CHATGPT_CIMD, cimdDoc(CHATGPT_CIMD, [CHATGPT_REDIRECT]));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT, ...S256() }))); // no window
    await openWindow(issuer, owner, { vendor: "claude", method: "cimd" });
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT, ...S256() }))); // another vendor's window
    expect(fetched).not.toContain(CHATGPT_CIMD);

    await openWindow(issuer, owner, { vendor: "chatgpt", method: "cimd" });
    const p = pkce();
    const back = await authorize(issuer, owner, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" });
    const t = await token(issuer, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: CHATGPT_REDIRECT, code_verifier: p.verifier, client_id: CHATGPT_CIMD });
    expect(t.status).toBe(200);
    expect((await callMcp(issuer, String(t.data["access_token"]))).status).toBe(200);

    // A document listing a foreign redirect is refused, even for the request's own redirect.
    const foreign = "https://chatgpt.com/oauth/foreign/client.json";
    documents.set(foreign, cimdDoc(foreign, [CHATGPT_REDIRECT, "https://evil.example/cb"]));
    await openWindow(issuer, owner, { vendor: "chatgpt", method: "cimd" });
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: foreign, redirect_uri: CHATGPT_REDIRECT, ...S256() })));
  });

  test("8d. Claude Code (direct): CIMD with a loopback redirect on any port", async () => {
    documents.set(CLAUDE_CODE_CIMD, cimdDoc(CLAUDE_CODE_CIMD, ["http://localhost/callback"], { application_type: "native", client_name: "Claude Code" }));
    await openWindow(issuer, owner, { vendor: "claude-code", method: "cimd" });
    const back = await authorize(issuer, owner, { client_id: CLAUDE_CODE_CIMD, redirect_uri: "http://localhost:49152/callback", ...S256() });
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  test("9. PKCE plain and a missing challenge are refused with the error page", async () => {
    const s = await staticWindow();
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, code_challenge: pkce().verifier, code_challenge_method: "plain" })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect })));
  });

  test("10. reusing an authorization code fails and revokes what it issued", async () => {
    const g = await staticGrant();
    expect((await callMcp(issuer, g.access)).status).toBe(200);
    const again = await token(issuer, { grant_type: "authorization_code", code: g.code, redirect_uri: g.redirect, code_verifier: g.verifier }, { id: g.id, secret: g.secret });
    expect(again.status).toBe(400);
    expect(again.data["error"]).toBe("invalid_grant");
    expect((await callMcp(issuer, g.access)).status).toBe(401);
    expect((await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, { id: g.id, secret: g.secret })).data["error"]).toBe("invalid_grant");
  });

  test("11. refresh reuse within 30 s returns the same pair; after 30 s it revokes the grant", async () => {
    const g = await staticGrant();
    const auth = { id: g.id, secret: g.secret };
    const first = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
    expect(first.status).toBe(200);
    expect(first.data["refresh_token"]).not.toBe(g.refresh); // rotated
    issuer.clock.advance(29_000);
    const concurrent = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
    expect(concurrent.data).toEqual(first.data);
    issuer.clock.advance(2_000);
    const late = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
    expect(late.data["error"]).toBe("invalid_grant");
    expect((await token(issuer, { grant_type: "refresh_token", refresh_token: String(first.data["refresh_token"]) }, auth)).data["error"]).toBe("invalid_grant");
    expect((await callMcp(issuer, String(first.data["access_token"]))).status).toBe(401);
  });

  test("11c. without offline_access (as ChatGPT asks) the grant outlives the owner's consent session", async () => {
    const s = await staticWindow("chatgpt");
    const p = pkce();
    const back = await authorize(issuer, owner, { client_id: s.id, redirect_uri: s.redirect, code_challenge: p.challenge, code_challenge_method: "S256", scope: "memory.read memory.write" });
    const auth = { id: s.id, secret: s.secret };
    const t = await token(issuer, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: s.redirect, code_verifier: p.verifier }, auth);
    expect(t.data["refresh_token"]).toBeTruthy();
    // The owner's browser session at the authorization server ends (10 minutes in production).
    issuer.db.prepare("DELETE FROM oidc_store WHERE model = 'Session'").run();
    expect((await callMcp(issuer, String(t.data["access_token"]))).status).toBe(200);
    const r = await token(issuer, { grant_type: "refresh_token", refresh_token: String(t.data["refresh_token"]) }, auth);
    expect(r.status).toBe(200);
    expect((await callMcp(issuer, String(r.data["access_token"]))).status).toBe(200);
  });

  test("11b. a `fixed` client policy keeps the refresh token (Gemini static, §5.3)", async () => {
    const g = await staticGrant("claude", { rotation: "fixed" });
    const auth = { id: g.id, secret: g.secret };
    const a = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
    issuer.clock.advance(60_000);
    const b = await token(issuer, { grant_type: "refresh_token", refresh_token: g.refresh }, auth);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.data["refresh_token"]).toBe(g.refresh);
    expect(b.data["access_token"]).not.toBe(a.data["access_token"]);
  });

  test("12. an invalid redirect_uri or client_id yields the error page, not a redirect", async () => {
    const s = await staticWindow();
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: "https://claude.ai/api/mcp/other", ...S256() })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: `${CLAUDE_REDIRECT}/`, ...S256() })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: "ma_unknown", redirect_uri: s.redirect, ...S256() })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256(), response_mode: "form_post" })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256(), resource: "https://elsewhere.example/mcp" })));
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
    for (const id of shapes) await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: id, redirect_uri: CHATGPT_REDIRECT, ...S256() })));
    expect(fetched.length).toBe(before); // none of them was fetched
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: "https://chatgpt.com/oauth/redirecting/client.json", redirect_uri: CHATGPT_REDIRECT, ...S256() })));
    await expectErrorPage(await owner.fetch(authUrl(issuer, { client_id: "https://chatgpt.com/oauth/private/client.json", redirect_uri: CHATGPT_REDIRECT, ...S256() })));
    expect(fetched).toContain("https://chatgpt.com/oauth/private/client.json");
    expect(docHits).toBe(0); // the private-address server was never reached
  });

  test("14. DCR fields outside the allow-list are refused; RFC 7592 endpoints are 404", async () => {
    for (const extra of [{ jwks_uri: "https://claude.ai/jwks" }, { logo_uri: "https://claude.ai/logo.png" }, { sector_identifier_uri: "https://claude.ai/s" }, { request_uris: [] }, { scope: "memory.admin" }]) {
      const w = await openWindow(issuer, owner, { vendor: "claude", method: "dcr" });
      expect(await register({ ...dcrClaude, ...extra })).toEqual({ status: 400, data: { error: "invalid_request" } });
      expect(issuer.pairing.get(w.window_id)?.registration_used).toBe(0);
    }
    for (const bad of [{ application_type: "native" }, { application_type: "browser" }, { grant_types: ["client_credentials"] }, { response_types: ["token"] }, { client_name: "x".repeat(65) }, { redirect_uris: [CLAUDE_REDIRECT, CLAUDE_REDIRECT, CLAUDE_REDIRECT] }]) {
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
  test("15. route inventory: nothing outside routes.allow.txt answers", async () => {
    const { unlisted, silent } = await routeInventory(issuer.origin);
    expect(unlisted).toEqual([]);
    expect(silent).toEqual([]);
  }, 60_000);

  test("16. /mcp ignores cookies and rejects a browser Origin", async () => {
    const g = await staticGrant();
    const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    expect((await callMcp(issuer, undefined, { cookie })).status).toBe(401);
    expect((await callMcp(issuer, g.access, { cookie })).status).toBe(200);
    expect((await callMcp(issuer, g.access, { origin: "https://evil.example" })).status).toBe(403);
    expect((await callMcp(issuer, g.access, { origin: issuer.origin })).status).toBe(403);
    expect((await callMcp(issuer, g.access, { origin: "null" })).status).toBe(200);
    const cors = await fetch(issuer.mcpUrl, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
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
      ["/oauth/reg", { method: "POST", headers: json, body: JSON.stringify({ ...dcrClaude, jwks_uri: "https://claude.ai/j" }) }],
      ["/oauth/reg", { method: "POST", headers: json, body: "not json" }],
      ["/oauth/reg", { method: "GET" }],
      [authUrl(issuer, { client_id: "ma_unknown", redirect_uri: CLAUDE_REDIRECT, ...S256() }), { method: "GET" }],
      [authUrl(issuer, { client_id: CHATGPT_CIMD, redirect_uri: CHATGPT_REDIRECT }), { method: "GET" }],
      ["/oauth/auth", { method: "GET" }],
      ["/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=x&client_id=ma_unknown" }],
      ["/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=x&client_id=memory-anywhere-cli" }],
    ];
    issuer.clock.advance(11 * 60_000); // let every window expire
    const closed = [];
    for (const [p, i] of probes) closed.push(await snapshot(p, i));
    for (const vendor of [["claude", "dcr"], ["chatgpt", "cimd"], ["pc", "static"]] as const) {
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

  test("19. consent needs the window's pair cookie or its pair code", async () => {
    const s = await staticWindow();
    const phone = new Browser(issuer.origin); // the vendor flow opened in another browser
    const start = await phone.fetch(authUrl(issuer, { client_id: s.id, redirect_uri: s.redirect, ...S256() }));
    const consentPath = start.headers.get("location") ?? "";
    expect(consentPath).toMatch(/^\/consent\//);
    const page = await (await phone.fetch(consentPath)).text();
    expect(page).toContain("Enter the code shown in your admin UI");
    expect(page).not.toContain("Approve");
    expect((await phone.postJson(`${consentPath}/options`)).status).toBe(403);
    expect((await phone.postJson(`${consentPath}/approve`, issuer.authenticator.get({ challenge: "x" }))).status).toBe(403);
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
    const cross = await owner.fetch(`${path2}/options`, { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(400);
    // Five wrong codes close the window.
    const w3 = await staticWindow();
    const other = new Browser(issuer.origin);
    const path3 = (await other.fetch(authUrl(issuer, { client_id: w3.id, redirect_uri: w3.redirect, ...S256() }))).headers.get("location") ?? "";
    for (let i = 0; i < 5; i++) await other.postJson(`${path3}/code`, { code: "BBBBBBBB" });
    expect(issuer.pairing.get(w3.w.window_id)?.close_reason).toBe("code_attempts");
  });

  test("20. MRTR requestState: tampered, expired, replayed or other-grant state falls back", () => {
    let t = 1_000_000;
    const states = new RequestStates(undefined, 60_000, () => t);
    const fresh = () => states.sign("grant-a", { step: 2 });
    expect(states.verify(fresh(), "grant-a")).toEqual({ step: 2 });
    const tok = fresh();
    const [body = "", mac = ""] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), d: { step: 9 } })).toString("base64url");
    expect(states.verify(`${forged}.${mac}`, "grant-a")).toBeNull();
    expect(states.verify(`${body}.${mac.slice(0, -2)}xx`, "grant-a")).toBeNull();
    expect(states.verify("garbage", "grant-a")).toBeNull();
    expect(states.verify(fresh(), "grant-b")).toBeNull();
    const replay = fresh();
    expect(states.verify(replay, "grant-a")).toEqual({ step: 2 });
    expect(states.verify(replay, "grant-a")).toBeNull();
    const old = fresh();
    t += 60_001;
    expect(states.verify(old, "grant-a")).toBeNull();
  });
});
