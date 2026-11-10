// The conformance tests that change nothing (1–3, 5, 6, 15–18; m0-spike.md §5), run against a
// deployed stage: MA_CONFORMANCE_ORIGIN=https://spike.{host} pnpm vitest run remote.test.ts
// Skipped when the variable is unset (CI runs the full suite against a local issuer instead).
// Without the owner's passkey these run with no pairing window open; the open-window halves of
// tests 4, 16 and 18 are covered by the local suite and by the vendor flows.

import { describe, expect, test } from "vitest";
import { routeInventory } from "./routes.ts";

const origin = process.env["MA_CONFORMANCE_ORIGIN"]?.replace(/\/$/, "") ?? "";
const mcpUrl = `${origin}/mcp`;
const form = { "content-type": "application/x-www-form-urlencoded" };

const mcpCall = (headers: Record<string, string> = {}) =>
  fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });

describe.skipIf(!origin)("deployed stage", () => {
  test("1. unauthenticated /mcp: 401 with the resource metadata challenge", async () => {
    const res = await mcpCall();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"`);
  });

  test("2. PRM resource is the MCP URL exactly; one authorization server", async () => {
    expect(await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()).toEqual({
      resource: mcpUrl,
      authorization_servers: [origin],
      scopes_supported: ["memory.read", "memory.write"],
      bearer_methods_supported: ["header"],
    });
  });

  test("3 and 17. both discovery paths: the same metadata, issuer = origin", async () => {
    const a = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    const b = await (await fetch(`${origin}/.well-known/openid-configuration`)).json();
    expect(a).toEqual(b);
    expect(a["issuer"]).toBe(origin);
    expect(a["client_id_metadata_document_supported"]).toBe(true);
    expect(a["token_endpoint_auth_methods_supported"]).toEqual(["none", "client_secret_post", "client_secret_basic"]);
    expect(a["authorization_response_iss_parameter_supported"]).toBe(true);
    expect(a["code_challenge_methods_supported"]).toEqual(["S256"]);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) expect(String(a[k])).toMatch(new RegExp(`^${origin}/oauth/`));
    expect(a["pushed_authorization_request_endpoint"]).toBeUndefined();
  });

  test("5. /token takes form encoding; a dead refresh token is invalid_grant", async () => {
    const res = await fetch(`${origin}/oauth/token`, { method: "POST", headers: form, body: "grant_type=refresh_token&refresh_token=not-a-real-token&client_id=memory-anywhere-cli" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("invalid_grant");
  });

  test("6. discovery and token answer within 10 s", async () => {
    const lap = async (f: () => Promise<Response>) => {
      const s = performance.now();
      await (await f()).arrayBuffer();
      return Math.round(performance.now() - s);
    };
    const discoveryMs = await lap(() => fetch(`${origin}/.well-known/oauth-authorization-server`));
    const tokenMs = await lap(() => fetch(`${origin}/oauth/token`, { method: "POST", headers: form, body: "grant_type=refresh_token&refresh_token=x&client_id=memory-anywhere-cli" }));
    const registrationMs = await lap(() => fetch(`${origin}/oauth/reg`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    console.log(JSON.stringify({ test: 6, discoveryMs, tokenMs, registrationMs }));
    expect(Math.max(discoveryMs, tokenMs, registrationMs)).toBeLessThan(10_000);
  });

  test("15. route inventory: nothing outside routes.allow.txt answers", async () => {
    const { unlisted, silent } = await routeInventory(origin);
    expect(unlisted).toEqual([]);
    expect(silent).toEqual([]);
  }, 120_000);

  test("16. /mcp ignores cookies and rejects a browser Origin", async () => {
    expect((await mcpCall({ cookie: "__Host-ma_admin=x; _session=y" })).status).toBe(401);
    expect((await mcpCall({ origin: "https://evil.example" })).status).toBe(403);
    expect((await mcpCall({ origin })).status).toBe(403);
    const pre = await fetch(mcpUrl, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("18. reg and auth failures are the one normalised response", async () => {
    const reg = await fetch(`${origin}/oauth/reg`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], application_type: "web" }) });
    expect(reg.status).toBe(400);
    expect(await reg.text()).toBe('{"error":"invalid_request"}');
    const auth = await fetch(`${origin}/oauth/auth?client_id=ma_unknown&response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback`, { redirect: "manual" });
    expect(auth.status).toBe(400);
    expect(auth.headers.get("location")).toBeNull();
    expect(await auth.text()).toContain("This request is not valid");
  });
});
