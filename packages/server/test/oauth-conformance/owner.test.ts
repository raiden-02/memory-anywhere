// The product's own auth rules beyond the M0 conformance list (auth-and-security.md §3–§5):
// owner setup and recovery, passkey independence and clone checks, rate limits, idle lifetimes,
// one grant per vendor with Replace, and what each grant may do at /mcp.

import { afterEach, describe, expect, test } from "vitest";
import { SERVER_VERSION } from "../../src/app.ts";
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
    const recipient = `age1${"q".repeat(58)}`;
    const r = await v1(issuer, pc.access, "POST", "/v1/admin/stepup", { command: "export", args: { include_auth: false, recipient } });
    const id = String(r.data["request_id"]);
    const page = await (await owner.fetch(`${issuer.adminOrigin}/approve/${id}`)).text();
    expect(page).toContain("WARNING: This key is not one of your registered export keys.");
    const suffix = (issuer.stepUps.view(id)?.confirmSuffix ?? "").toUpperCase();
    expect((await approve(issuer, owner, id, "00000000")).data).toEqual({ error: "wrong_suffix" });
    expect((await approve(issuer, owner, id, suffix)).data).toEqual({ result: "second" });
    expect((await approve(issuer, owner, id)).data).toEqual({ result: "approved" });
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

describe("rate limits (operations.md §3)", () => {
  test("/oauth/auth answers 429 after the per-IP limit", async () => {
    const issuer = await issuerWith({ rateLimits: { authorize_per_ip_per_min: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${issuer.origin}${authUrl(issuer, { client_id: "ma_x", redirect_uri: CLAUDE_REDIRECT })}`, { redirect: "manual" })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  }, 30_000);
});
