// The product's own auth rules beyond the M0 conformance list (auth-and-security.md §3–§5):
// owner setup and recovery, passkey independence and clone checks, rate limits, idle lifetimes,
// one grant per vendor with Replace, and what each grant may do at /mcp.

import { afterEach, describe, expect, test, vi } from "vitest";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { SERVER_VERSION } from "../../src/app.ts";
import { fakeEmbedder } from "../helpers/store.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { authorize, authUrl, Browser, callMcp, openWindow, ownerSetup, pkce, startIssuer, token, type Issuer } from "./issuer.ts";

const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const DAY = 86_400_000;
const running: Issuer[] = [];
afterEach(async () => {
  for (const i of running.splice(0)) await i.stop();
});

async function issuerWith(opts: Parameters<typeof startIssuer>[0] = {}): Promise<Issuer> {
  const issuer = await startIssuer(opts);
  running.push(issuer);
  return issuer;
}

/** Pair, consent and exchange the code; returns the tokens and the static credentials. */
async function grant(issuer: Issuer, owner: Browser, body: Record<string, unknown>, redirect = CLAUDE_REDIRECT) {
  const w = await openWindow(issuer, owner, body);
  const clientId = w.credentials?.client_id ?? "memory-anywhere-cli";
  const p = pkce();
  const scope = clientId === "memory-anywhere-cli" ? "memory.read memory.write memory.capture offline_access" : undefined;
  const back = await authorize(issuer, owner, { client_id: clientId, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", ...(scope ? { scope } : {}) });
  const basic = w.credentials ? { id: w.credentials.client_id, secret: w.credentials.client_secret } : undefined;
  const form = { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: redirect, code_verifier: p.verifier, ...(basic ? {} : { client_id: clientId }) };
  const t = await token(issuer, form, basic);
  expect(t.status, JSON.stringify(t.data)).toBe(200);
  return { access: String(t.data["access_token"]), refresh: String(t.data["refresh_token"]), basic, clientId };
}

async function toolNames(issuer: Issuer, access: string): Promise<string[]> {
  const res = await callMcp(issuer, access);
  // The answer is one JSON-RPC message, as JSON or as a one-event stream.
  const text = await res.text();
  const json = text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}");
  const body = JSON.parse(json) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

describe("owner setup and recovery (§3.1, §3.3)", () => {
  test("the first start of an empty store issues one setup token; a restart issues none", async () => {
    const issuer = await issuerWith();
    expect(issuer.owner.issueFirstSetupToken()).toBe(true);
    expect(issuer.owner.issueFirstSetupToken()).toBe(false);
  }, 30_000);

  test("a second synced passkey from an unknown provider needs the owner's confirmation", async () => {
    const issuer = await issuerWith();
    const browser = new Browser(issuer.origin);
    const token0 = issuer.issueSetupToken();
    const admin = (p: string) => `${issuer.adminOrigin}${p}`;
    const synced = [new SoftAuthenticator(issuer.adminOrigin, { synced: true }), new SoftAuthenticator(issuer.adminOrigin, { synced: true })];
    const add = async (a: SoftAuthenticator, extra: Record<string, unknown> = {}) => {
      const options = await browser.postJson(admin("/setup/options"), { token: token0 });
      return browser.postJson(admin("/setup/verify"), { token: token0, response: a.create(options.data as never), ...extra });
    };
    expect((await add(synced[0] as SoftAuthenticator)).data).toEqual({ next: "second_passkey" });
    expect((await add(synced[1] as SoftAuthenticator)).data).toEqual({ error: "same_provider" });
    const confirmed = await add(synced[1] as SoftAuthenticator, { differentProviders: true });
    expect((confirmed.data["codes"] as string[]).length).toBe(10);
    // Typing back a code that is not one of them does not finish setup; one of them does.
    expect((await browser.postJson(admin("/setup/confirm"), { token: token0, code: "AAAA-BBBB-CCCC-DDDD" })).status).toBe(403);
    expect((await browser.postJson(admin("/setup/confirm"), { token: token0, code: (confirmed.data["codes"] as string[])[0] })).status).toBe(200);
    expect((await browser.postJson(admin("/setup/options"), { token: token0 })).status).toBe(403); // the token is spent
  }, 60_000);

  test("a recovery code revokes every passkey and session and opens a new enrollment; grants stay", async () => {
    const issuer = await issuerWith();
    const token0 = issuer.issueSetupToken();
    const browser = new Browser(issuer.origin);
    const admin = (p: string) => `${issuer.adminOrigin}${p}`;
    let codes: string[] = [];
    for (const a of [issuer.authenticator, issuer.second]) {
      const options = await browser.postJson(admin("/setup/options"), { token: token0 });
      const r = await browser.postJson(admin("/setup/verify"), { token: token0, response: a.create(options.data as never) });
      codes = (r.data["codes"] as string[] | undefined) ?? codes;
    }
    await browser.postJson(admin("/setup/confirm"), { token: token0, code: codes[0] });
    const g = await grant(issuer, browser, { vendor: "claude", method: "static" });

    const stranger = new Browser(issuer.origin);
    expect((await stranger.postJson(admin("/recover"), { code: "AAAA-BBBB-CCCC-DDDD" })).status).toBe(403);
    const r = await stranger.postJson(admin("/recover"), { code: codes[5] });
    expect(r.status).toBe(200);
    const enrollment = String(r.data["enroll"]).split("#")[1] ?? "";
    expect(issuer.passkeys.count()).toBe(0);
    expect((await browser.postJson(admin("/api/stepup/options"))).status).toBe(401); // the old session ended
    expect((await stranger.postJson(admin("/recover"), { code: codes[5] })).status).toBe(403); // each code works once
    const fresh = new SoftAuthenticator(issuer.adminOrigin);
    const options = await stranger.postJson(admin("/setup/options"), { token: enrollment });
    expect((await stranger.postJson(admin("/setup/verify"), { token: enrollment, response: fresh.create(options.data as never) })).data).toEqual({ next: "second_passkey" });
    expect((await callMcp(issuer, g.access)).status).toBe(200);
    expect(issuer.app.alerts.open().map((a) => a.kind)).toContain("recovery_used");
  }, 90_000);

  test("setup race: a second browser holding the same token cannot add a passkey once setup is confirmed", async () => {
    const issuer = await issuerWith();
    const token = issuer.issueSetupToken();
    const admin = (p: string) => `${issuer.adminOrigin}${p}`;
    const racer = new Browser(issuer.origin);
    // The racer fetched options with the token before the owner finished.
    const early = await racer.postJson(admin("/setup/options"), { token });
    expect(early.status).toBe(200);
    // The owner completes setup with the same token (two passkeys, a code typed back).
    let codes: string[] = [];
    const owner = new Browser(issuer.origin);
    for (const a of [issuer.authenticator, issuer.second]) {
      const options = await owner.postJson(admin("/setup/options"), { token });
      codes = ((await owner.postJson(admin("/setup/verify"), { token, response: a.create(options.data as never) })).data["codes"] as string[] | undefined) ?? codes;
    }
    expect((await owner.postJson(admin("/setup/confirm"), { token, code: codes[2] })).status).toBe(200);
    const attacker = new SoftAuthenticator(issuer.adminOrigin);
    expect((await racer.postJson(admin("/setup/verify"), { token, response: attacker.create(early.data as never) })).status).toBe(403);
    expect((await racer.postJson(admin("/setup/confirm"), { token, code: codes[2] })).status).toBe(403);
    expect(issuer.passkeys.count()).toBe(2);
  }, 60_000);

  test("recovery brute force: wrong codes raise auth_fail at five, and the sixth try in an hour answers 429", async () => {
    const issuer = await issuerWith();
    await ownerSetup(issuer);
    const stranger = new Browser(issuer.origin);
    const tries: number[] = [];
    for (let i = 0; i < 6; i++) tries.push((await stranger.postJson(`${issuer.adminOrigin}/recover`, { code: `AAAA-BBBB-CCCC-${String(1000 + i)}` })).status);
    expect(tries).toEqual([403, 403, 403, 403, 403, 429]);
    expect(issuer.app.alerts.open().map((a) => a.kind)).toContain("auth_fail");
  }, 60_000);
});

describe("passkeys (§3.2)", () => {
  test("a counter that goes back blocks the passkey and raises passkey_clone; a counter that stays 0 is fine", async () => {
    const issuer = await issuerWith();
    await ownerSetup(issuer);
    const browser = new Browser(issuer.origin);
    const login = async (a: SoftAuthenticator) => {
      const options = await browser.postJson(`${issuer.adminOrigin}/api/login/options`);
      return (await browser.postJson(`${issuer.adminOrigin}/api/login/verify`, a.get(options.data as never))).status;
    };
    expect(await login(issuer.authenticator)).toBe(200);
    issuer.authenticator.counter = 0; // a copy of the key, made earlier
    expect(await login(issuer.authenticator)).toBe(403);
    expect(issuer.app.alerts.open().map((a) => a.kind)).toContain("passkey_clone");
    expect(issuer.passkeys.count()).toBe(1);
    expect(await login(issuer.second)).toBe(200);
  }, 60_000);

  test("five failed sign-ins in ten minutes raise auth_fail", async () => {
    const issuer = await issuerWith();
    await ownerSetup(issuer);
    const browser = new Browser(issuer.origin);
    const outsider = new SoftAuthenticator(issuer.adminOrigin);
    outsider.create({ challenge: "x", rp: { id: "127.0.0.1" } });
    for (let i = 0; i < 5; i++) {
      const options = await browser.postJson(`${issuer.adminOrigin}/api/login/options`);
      expect((await browser.postJson(`${issuer.adminOrigin}/api/login/verify`, outsider.get(options.data as never))).status).toBe(403);
    }
    expect(issuer.app.alerts.open().map((a) => a.kind)).toContain("auth_fail");
  }, 60_000);
});

describe("pairing and grants (§4.1, §5.2, §5.5)", () => {
  test("one grant per vendor: pairing again needs Replace, which ends the old grant on approval", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const first = await grant(issuer, owner, { vendor: "claude", method: "static" });
    expect((await owner.postJson(`${issuer.adminOrigin}/api/windows`, { vendor: "claude", method: "static", replace: false })).data["error"]).toBe("replace_required");
    expect((await callMcp(issuer, first.access)).status).toBe(200);
    await grant(issuer, owner, { vendor: "claude", method: "static", replace: true });
    expect((await callMcp(issuer, first.access)).status).toBe(401);
    expect(issuer.app.alerts.open().filter((a) => a.kind === "grant_created")[0]?.count).toBe(2);
  }, 60_000);

  test("the PC gets the capture scope and every tool; a read-only Other app gets no write tools", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    expect(await toolNames(issuer, pc.access)).toEqual(["memory_recall", "memory_profile", "memory_save", "memory_forget", "memory_status"]);
    const other = await grant(issuer, owner, { vendor: "other", method: "static", otherHost: "app.example.org", redirectUri: "https://app.example.org/cb", write: false }, "https://app.example.org/cb");
    expect(await toolNames(issuer, other.access)).toEqual(["memory_recall", "memory_profile", "memory_status"]);
  }, 60_000);

  test("a grant unused for longer than its idle limit cannot be refreshed (PC: 7 days)", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    issuer.clock.advance(6 * DAY);
    const kept = await token(issuer, { grant_type: "refresh_token", refresh_token: pc.refresh, client_id: "memory-anywhere-cli" });
    expect(kept.status).toBe(200);
    issuer.clock.advance(8 * DAY);
    const idle = await token(issuer, { grant_type: "refresh_token", refresh_token: String(kept.data["refresh_token"]), client_id: "memory-anywhere-cli" });
    expect(idle.data["error"]).toBe("invalid_grant");
    expect((await callMcp(issuer, String(kept.data["access_token"]))).status).toBe(401);
  }, 60_000);

  test("the PC consent page shows the code mema login prints, derived from its PKCE challenge", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    await openWindow(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" });
    const { loginCode } = await import("@memory-anywhere/contracts/login-code");
    const p = pkce();
    const start = await owner.fetch(authUrl(issuer, { client_id: "memory-anywhere-cli", redirect_uri: "http://127.0.0.1:50123/callback", code_challenge: p.challenge, code_challenge_method: "S256", scope: "memory.read memory.write memory.capture offline_access" }));
    const page = await (await owner.fetch(start.headers.get("location") ?? "")).text();
    expect(page).toContain(loginCode(p.challenge));
  }, 60_000);
});

describe("step-up for the CLI's owner commands (§6.2)", () => {
  const v1 = async (issuer: Issuer, access: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`${issuer.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "ma-client-version": SERVER_VERSION, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  /** The owner opens the approval page, signs the challenge, and approves (optionally typing the key's suffix). */
  const approve = async (issuer: Issuer, owner: Browser, id: string, confirm?: string) => {
    const base = `${issuer.adminOrigin}/approve/${id}`;
    expect((await owner.fetch(base)).status).toBe(200);
    const options = await owner.postJson(`${base}/options`);
    return owner.postJson(`${base}/approve`, { response: issuer.authenticator.get(options.data as never), ...(confirm === undefined ? {} : { confirm }) });
  };

  test("a PC command runs once, with exactly the approved arguments, after the owner approves with a passkey", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    const args = { name: "Atlas", aliases: ["atlas-app"], status: "active" };
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/project-add", args)).status).toBe(403);

    const r = await v1(issuer, pc.access, "POST", "/v1/admin/stepup", { command: "project-add", args });
    expect(r.status).toBe(200);
    const id = String(r.data["request_id"]);
    expect(r.data["approve_url"]).toBe(`${issuer.adminOrigin}/approve/${id}`);
    expect(String(r.data["user_code"])).toMatch(/^[A-Z2-9]{8}$/u);
    const page = await (await owner.fetch(`${issuer.adminOrigin}/approve/${id}`)).text();
    expect(page).toContain("Add project &quot;Atlas&quot;.");
    expect(page).toContain(String(r.data["user_code"]));
    expect((await v1(issuer, pc.access, "GET", `/v1/admin/stepup/${id}`)).data).toEqual({ status: "pending" });

    expect((await approve(issuer, owner, id)).data).toEqual({ result: "approved" });
    const polled = await v1(issuer, pc.access, "GET", `/v1/admin/stepup/${id}`);
    const stepUp = String(polled.data["token"]);
    expect(polled.data).toMatchObject({ status: "approved", token_expires_in: 600 });
    expect((await v1(issuer, pc.access, "GET", `/v1/admin/stepup/${id}`)).data).toEqual({ status: "approved" }); // handed out once

    const header = { "ma-step-up": stepUp };
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/project-add", { ...args, name: "Other" }, header)).status).toBe(403);
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/project-add", args, header)).status).toBe(200);
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/project-add", args, header)).status).toBe(403); // single use
  }, 90_000);

  test("the PC lists pending review ids without a step-up, but resolving one needs it", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    const listed = await v1(issuer, pc.access, "POST", "/v1/admin/review", { approve: [], reject: [] });
    expect(listed.status).toBe(200);
    expect(listed.data).toEqual({ resolved: 0, pending: [] });
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/review", { approve: ["rev_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C"], reject: [] })).status).toBe(403);
    expect((await v1(issuer, pc.access, "POST", "/v1/admin/review", { approve: [], reject: [], extra: 1 })).status).toBe(403);
  }, 60_000);

  test("chat apps cannot start owner commands", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const claude = await grant(issuer, owner, { vendor: "claude", method: "static" });
    expect((await v1(issuer, claude.access, "POST", "/v1/admin/stepup", { command: "project-add", args: { name: "X", aliases: [] } })).status).toBe(403);
  }, 60_000);

  test("an export to an unregistered key needs the key's last 8 characters and a second approval", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const r = await v1(issuer, pc.access, "POST", "/v1/admin/stepup", { command: "export", args: { include_auth: false, recipient } });
    const id = String(r.data["request_id"]);
    const page = await (await owner.fetch(`${issuer.adminOrigin}/approve/${id}`)).text();
    expect(page).toContain("WARNING: This key is not one of your registered export keys.");
    const suffix = (issuer.stepUps.view(id)?.confirmSuffix ?? "").toUpperCase();
    expect((await approve(issuer, owner, id, "00000000")).data).toEqual({ error: "wrong_suffix" });
    expect((await approve(issuer, owner, id, suffix)).data).toEqual({ result: "second" });
    expect((await approve(issuer, owner, id)).data).toEqual({ result: "approved" });

    // The approved export runs once and comes back encrypted to that key.
    const stepUp = String((await v1(issuer, pc.access, "GET", `/v1/admin/stepup/${id}`)).data["token"]);
    const res = await fetch(`${issuer.origin}/v1/admin/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${pc.access}`, "content-type": "application/json", "ma-client-version": SERVER_VERSION, "ma-step-up": stepUp },
      body: JSON.stringify({ include_auth: false, recipient }),
    });
    const d = new Decrypter();
    d.addIdentity(identity);
    expect(JSON.parse(await d.decrypt(new Uint8Array(await res.arrayBuffer()), "text"))).toMatchObject({ format: "memory-anywhere-store", kind: "full" });
    expect(issuer.db.prepare("SELECT stepup_request_id FROM export_log").get()).toEqual({ stepup_request_id: id });
  }, 90_000);

  test("three denied requests in an hour raise stepup_unexpected", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const pc = await grant(issuer, owner, { vendor: "pc", method: "static", machineName: "desk" }, "http://127.0.0.1:50123/callback");
    for (let i = 0; i < 3; i++) {
      const r = await v1(issuer, pc.access, "POST", "/v1/admin/stepup", { command: "repo-disable", args: { repo_key: `rk_${"a".repeat(32)}` } });
      await owner.fetch(`${issuer.adminOrigin}/approve/${String(r.data["request_id"])}`);
      expect((await owner.postJson(`${issuer.adminOrigin}/approve/${String(r.data["request_id"])}/deny`)).status).toBe(200);
    }
    expect(issuer.app.alerts.open().map((a) => a.kind)).toContain("stepup_unexpected");
  }, 90_000);
});

describe("elicitation for a verified client (mcp-interface.md §5)", () => {
  const ENVELOPE = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } };
  const PREFERENCE = { content: "Prefers short answers to quick questions", kind: "preference", why_durable: "how to answer", user_words: "I prefer short answers to quick questions", explicit_request: false };

  async function rpc(issuer: Issuer, access: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(issuer.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": String(params["name"]),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: ENVELOPE, ...params } }),
    });
    const text = await res.text();
    const json = text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}");
    const body = JSON.parse(json) as { result?: Record<string, unknown> };
    if (!body.result) throw new Error(`tools/call: ${res.status} ${text}`);
    return body.result;
  }

  test("Claude asks the person, and the answered retry stores the preference at T1; the state works once", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const claude = await grant(issuer, owner, { vendor: "claude", method: "static" });
    issuer.db.prepare("UPDATE client_policy SET elicitation = 'verified' WHERE vendor = 'claude'").run();

    const asked = await rpc(issuer, claude.access, { name: "memory_save", arguments: PREFERENCE });
    expect(JSON.stringify(asked)).toContain("Apply this preference in all your AI apps");
    const state = String(asked["requestState"]);
    const answer = { inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, requestState: state };
    const saved = await rpc(issuer, claude.access, { name: "memory_save", arguments: PREFERENCE, ...answer });
    expect(saved["structuredContent"]).toMatchObject({ outcome: "active", tier: "T1" });
    // A replayed answer is no answer: the table's "else" branch.
    const replayed = await rpc(issuer, claude.access, { name: "memory_save", arguments: { ...PREFERENCE, content: "Prefers short answers to every question" }, ...answer });
    expect((replayed["structuredContent"] as { tier?: string } | undefined)?.tier).not.toBe("T1");
  }, 60_000);

  test("an unverified client is never asked", async () => {
    const issuer = await issuerWith();
    const owner = await ownerSetup(issuer);
    const claude = await grant(issuer, owner, { vendor: "claude", method: "static" });
    const r = await rpc(issuer, claude.access, { name: "memory_save", arguments: PREFERENCE });
    expect(r["requestState"]).toBeUndefined();
    expect(r["structuredContent"]).toBeDefined();
  }, 60_000);
});

describe("rate limits (operations.md §3)", () => {
  test("/oauth/auth answers 429 after the per-IP limit", async () => {
    const issuer = await issuerWith({ rateLimits: { authorize_per_ip_per_min: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${issuer.origin}${authUrl(issuer, { client_id: "ma_x", redirect_uri: CLAUDE_REDIRECT })}`, { redirect: "manual" })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  }, 30_000);

  test("an unauthenticated flood gets 401, then 429 per address, and does no store or embedding work", async () => {
    const issuer = await issuerWith({ rateLimits: { unauth_per_ip_per_min: 5 } });
    const query = vi.spyOn(fakeEmbedder, "embedQuery");
    const documents = vi.spyOn(fakeEmbedder, "embedDocuments");
    const rows = () => ["write_request", "read_ledger", "memory", "event"].map((t) => (issuer.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    const before = rows();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await callMcp(issuer, `not-a-token-${i}`)).status);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${issuer.origin}/v1/recall`, {
        method: "POST", headers: { authorization: "Bearer forged", "content-type": "application/json", "ma-client-version": SERVER_VERSION }, body: JSON.stringify({ query: "where do I live" }),
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(query).not.toHaveBeenCalled();
    expect(documents).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
    query.mockRestore();
    documents.mockRestore();
  }, 30_000);

  test("one grant's requests past mcp_per_grant_per_min answer 429", async () => {
    const issuer = await issuerWith({ rateLimits: { mcp_per_grant_per_min: 3 } });
    const owner = await ownerSetup(issuer);
    const g = await grant(issuer, owner, { vendor: "claude", method: "static" });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await callMcp(issuer, g.access)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  }, 60_000);

  test("/oauth/token answers 429 after the per-IP limit", async () => {
    const issuer = await issuerWith({ rateLimits: { token_per_ip_per_min: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await token(issuer, { grant_type: "refresh_token", refresh_token: `dead-${i}`, client_id: "memory-anywhere-cli" })).status);
    expect(statuses).toEqual([400, 400, 429]);
  }, 30_000);
});
