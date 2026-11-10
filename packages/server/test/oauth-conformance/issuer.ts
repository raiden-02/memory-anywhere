// Test harness for the OAuth conformance suite (m0-spike.md §5). It starts a local issuer and
// drives it the way a vendor and the owner's browser would. M0 runs the suite against the spike
// (spikes/oauth-oidc-provider); M2 points startIssuer at the product server and keeps the tests.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppOptions } from "../../../../spikes/oauth-oidc-provider/src/app.ts";
import { SoftAuthenticator } from "./authenticator.ts";

export type Issuer = Awaited<ReturnType<typeof startIssuer>>;

/** A fake clock for the server's own timers (pairing windows, refresh grace). */
export class Clock {
  offset = 0;
  now = (): number => Date.now() + this.offset;
  advance(ms: number): void {
    this.offset += ms;
  }
}

export async function startIssuer(opts: Partial<Pick<AppOptions, "fetch">> = {}) {
  // A data directory with a space in its path, as on Windows (config-and-cli.md §3).
  const dataDir = mkdtempSync(join(tmpdir(), "ma oauth "));
  const clock = new Clock();
  // The issuer URL contains the port, so take a free port first, then create the app for it.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({ publicOrigin: origin, dataDir, version: "0.0.0-test", now: clock.now, ...opts });
  await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));
  const authenticator = new SoftAuthenticator(origin);
  return {
    ...app,
    origin,
    clock,
    authenticator,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A browser: a cookie jar, same-origin fetch metadata on POSTs, no automatic redirects. */
export class Browser {
  readonly jar = new Map<string, string>();
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  async fetch(pathOrUrl: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(pathOrUrl, this.origin);
    const headers: Record<string, string> = { ...init.headers };
    if (this.jar.size) headers["cookie"] = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.method === "POST" && url.origin === this.origin) {
      headers["origin"] ??= this.origin;
      headers["sec-fetch-site"] ??= "same-origin";
    }
    const res = await fetch(url, { method: init.method ?? "GET", headers, redirect: "manual", ...(init.body !== undefined ? { body: init.body } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair?.indexOf("=") ?? -1;
      if (!pair || i < 1) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=thu, 01 jan 1970/i.test(a));
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  async postJson(path: string, body: unknown = {}): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await this.fetch(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }
}

/** The owner: enrols the passkey, signs in, opens windows. */
export async function ownerSetup(issuer: Issuer): Promise<Browser> {
  const owner = new Browser(issuer.origin);
  const token = issuer.issueSetupToken();
  const options = await owner.postJson("/setup/options", { token });
  if (options.status !== 200) throw new Error(`setup options: ${JSON.stringify(options)}`);
  const verified = await owner.postJson("/setup/verify", { token, response: issuer.authenticator.create(options.data as never) });
  if (verified.status !== 200) throw new Error(`setup verify: ${JSON.stringify(verified)}`);
  return owner;
}

export interface WindowInfo {
  window_id: string;
  pair_code: string;
  pair_link: string;
  credentials?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

export async function openWindow(issuer: Issuer, owner: Browser, body: Record<string, unknown>, bind = true): Promise<WindowInfo> {
  let r = await owner.postJson("/admin/api/windows", body);
  // Like the admin page: sign in again after the idle timeout, step up after 5 minutes (§3.4).
  if (r.data["error"] === "login_required") {
    const options = await owner.postJson("/admin/api/login/options");
    await owner.postJson("/admin/api/login/verify", issuer.authenticator.get(options.data as never));
    r = await owner.postJson("/admin/api/windows", body);
  }
  if (r.data["error"] === "step_up_required") {
    const options = await owner.postJson("/admin/api/stepup/options");
    await owner.postJson("/admin/api/stepup/verify", issuer.authenticator.get(options.data as never));
    r = await owner.postJson("/admin/api/windows", body);
  }
  if (r.status !== 200) throw new Error(`open window: ${JSON.stringify(r)}`);
  const w = r.data as unknown as WindowInfo;
  if (bind) {
    const res = await owner.fetch(w.pair_link);
    if (res.status !== 303) throw new Error(`pair link: ${res.status}`);
  }
  return w;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
  state?: string;
  [extra: string]: string | undefined;
}

export function authUrl(issuer: Issuer, p: AuthRequest): string {
  const q = new URLSearchParams({ response_type: "code", scope: "memory.read memory.write offline_access", resource: issuer.mcpUrl, state: "st-1" });
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/oauth/auth?${q}`;
}

/** Runs /oauth/auth through consent with the passkey; returns the final redirect to the client. */
export async function authorize(issuer: Issuer, browser: Browser, p: AuthRequest): Promise<URL> {
  const start = await browser.fetch(authUrl(issuer, p));
  const consentPath = start.headers.get("location");
  if (start.status !== 303 || !consentPath?.startsWith("/consent/")) throw new Error(`authorize: ${start.status} ${await start.text()}`);
  const page = await browser.fetch(consentPath);
  if (page.status !== 200) throw new Error(`consent page: ${page.status}`);
  const options = await browser.postJson(`${consentPath}/options`);
  if (options.status !== 200) throw new Error(`consent options: ${JSON.stringify(options)}`);
  const approved = await browser.postJson(`${consentPath}/approve`, issuer.authenticator.get(options.data as never));
  if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved)}`);
  const resume = await browser.fetch(String(approved.data["redirectTo"]));
  const location = resume.headers.get("location");
  if (resume.status !== 303 || !location) throw new Error(`resume: ${resume.status} ${await resume.text()}`);
  return new URL(location, issuer.origin);
}

export async function token(issuer: Issuer, form: Record<string, string>, basic?: { id: string; secret: string }): Promise<{ status: number; data: Record<string, unknown>; raw: Response }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (basic) headers["authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString("base64")}`;
  const raw = await fetch(`${issuer.origin}/oauth/token`, { method: "POST", headers, body: new URLSearchParams(form).toString() });
  return { status: raw.status, data: (await raw.clone().json().catch(() => ({}))) as Record<string, unknown>, raw };
}

export async function callMcp(issuer: Issuer, accessToken: string | undefined, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(issuer.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}
