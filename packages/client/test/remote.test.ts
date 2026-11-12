// The PC against a remote store (M2 P6): `mema login` through the real authorization server and a
// scripted owner's browser and passkey, the token cache's refresh under its lock, the 401 retry,
// logout, the owner commands' step-up, export, and leaving local mode with `mema connect`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loginCode } from "@memory-anywhere/contracts/login-code";
import { authorize, openWindow, ownerSetup, startIssuer, type Browser, type Issuer } from "../../server/test/oauth-conformance/issuer.ts";
import { accessToken, AuthError, login, logout, readTokens, type AuthDeps } from "../src/auth.ts";
import { connect, exportStore, ui, type CommandDeps } from "../src/commands.ts";
import { parseClientConfig, type ClientConfigT } from "../src/config.ts";
import { adminCall, StepUpError } from "../src/stepup.ts";
import { StoreClient } from "../src/store-client.ts";
import { tempHome } from "./helpers.ts";

let issuer: Issuer;
let owner: Browser;
beforeAll(async () => {
  issuer = await startIssuer();
  owner = await ownerSetup(issuer);
}, 60_000);
afterAll(async () => {
  await issuer.stop();
});

const noWait = async (): Promise<void> => undefined;
const remoteConfig = (url: string): ClientConfigT => parseClientConfig(`schema = 1\n[store]\nmode = "remote"\nurl = "${url}"\n`).config;

/** The owner's browser: follows the login link through consent with the passkey, then lands on the loopback callback. */
async function approveLogin(url: string): Promise<boolean> {
  const q = new URL(url).searchParams;
  const back = await authorize(issuer, owner, { ...Object.fromEntries(q), client_id: q.get("client_id") ?? "", redirect_uri: q.get("redirect_uri") ?? "" });
  await fetch(back);
  return true;
}

/** Signs a fresh PC home in; returns its auth deps and what `mema login` printed. */
async function signedIn(): Promise<{ deps: AuthDeps; lines: string[]; cleanup: () => void; challenge: string }> {
  await openWindow(issuer, owner, { vendor: "pc", method: "static", machineName: "desk", replace: true });
  const h = tempHome();
  const lines: string[] = [];
  let challenge = "";
  const deps: AuthDeps = { paths: h.paths, fetch, now: Date.now, sleep: noWait };
  await login(issuer.origin, deps, {
    out: (l) => lines.push(l),
    machineName: "desk",
    openBrowser: async (url) => {
      challenge = new URL(url).searchParams.get("code_challenge") ?? "";
      return approveLogin(url);
    },
  });
  return { deps, lines, cleanup: h.cleanup, challenge };
}

describe("mema login and the token cache", () => {
  test("login: PKCE on a loopback redirect; the printed code names this request; tokens.json is written", async () => {
    const s = await signedIn();
    try {
      expect(s.lines.join("\n")).toContain(`Login code: ${loginCode(s.challenge)}`);
      const t = readTokens(s.deps.paths);
      expect(t).toMatchObject({ issuer: issuer.origin, client_id: "memory-anywhere-cli" });
      expect(Date.parse(t?.access_expires_at ?? "")).toBeGreaterThan(Date.now());
      const store = StoreClient.from(remoteConfig(issuer.origin), s.deps.paths, fetch, {});
      expect(await store.request<{ store: string }>("GET", "/v1/status", undefined, 5000)).toMatchObject({ store: "local" });
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("an access token about to expire is refreshed once, even by two processes at the same moment", async () => {
    const s = await signedIn();
    try {
      const before = readTokens(s.deps.paths);
      writeFileSync(s.deps.paths.tokensFile, JSON.stringify({ ...before, access_expires_at: new Date(Date.now() + 10_000).toISOString() }));
      const realSleep = { ...s.deps, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
      const [a, b] = await Promise.all([accessToken(issuer.origin, realSleep), accessToken(issuer.origin, realSleep)]);
      expect(a).toBe(b);
      expect(a).not.toBe(before?.access_token);
      expect(readTokens(s.deps.paths)?.refresh_token).not.toBe(before?.refresh_token); // the PC's refresh token rotates
      expect(issuer.app.alerts.open().map((x) => x.kind)).not.toContain("refresh_reuse");
      expect(existsSync(s.deps.paths.tokensLock)).toBe(false);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("a 401 refreshes the token and retries once", async () => {
    const s = await signedIn();
    try {
      const t = readTokens(s.deps.paths);
      writeFileSync(s.deps.paths.tokensFile, JSON.stringify({ ...t, access_token: "revoked-or-garbled" }));
      const store = StoreClient.from(remoteConfig(issuer.origin), s.deps.paths, fetch, {});
      expect(await store.request("GET", "/v1/status", undefined, 5000)).toBeDefined();
      expect(readTokens(s.deps.paths)?.access_token).not.toBe("revoked-or-garbled");
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("logout revokes the grant at the store; afterwards the PC must log in again", async () => {
    const s = await signedIn();
    try {
      const refresh = readTokens(s.deps.paths)?.refresh_token ?? "";
      expect(await logout(s.deps)).toBe("revoked");
      expect(existsSync(s.deps.paths.tokensFile)).toBe(false);
      const reuse = await fetch(`${issuer.origin}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "memory-anywhere-cli" }).toString(),
      });
      expect(reuse.status).toBe(400);
      await expect(accessToken(issuer.origin, s.deps)).rejects.toBeInstanceOf(AuthError);
      const store = StoreClient.from(remoteConfig(issuer.origin), s.deps.paths, fetch, {});
      await expect(store.request("GET", "/v1/status", undefined, 5000)).rejects.toMatchObject({ kind: "unauthorized" });
    } finally {
      s.cleanup();
    }
  }, 60_000);
});

describe("owner commands from the PC (step-up)", () => {
  /** The owner's answer on the approval page. */
  const onApprovalPage = (answer: "approve" | "deny") => async (url: string): Promise<boolean> => {
    expect(url.startsWith(`${issuer.adminOrigin}/approve/`)).toBe(true);
    expect((await owner.fetch(url)).status).toBe(200);
    if (answer === "deny") return (await owner.postJson(`${url}/deny`)).status === 200;
    const options = await owner.postJson(`${url}/options`);
    return (await owner.postJson(`${url}/approve`, { response: issuer.authenticator.get(options.data as never) })).status === 200;
  };

  async function pcDeps(answer: "approve" | "deny"): Promise<{ d: CommandDeps; lines: string[]; cleanup: () => void }> {
    const s = await signedIn();
    const config = remoteConfig(issuer.origin);
    const lines: string[] = [];
    const d: CommandDeps = {
      paths: s.deps.paths, config, store: StoreClient.from(config, s.deps.paths, fetch, {}), cwd: process.cwd(), out: (l) => lines.push(l),
      ask: async (_q, fallback) => fallback, now: Date.now, sleep: noWait, openBrowser: onApprovalPage(answer),
    };
    return { d, lines, cleanup: s.cleanup };
  }

  test("a command runs after the owner approves it with a passkey, for exactly its arguments", async () => {
    const { d, lines, cleanup } = await pcDeps("approve");
    try {
      await adminCall(d, "project-add", { name: "Orrery", aliases: [] });
      expect(lines.join("\n")).toMatch(/Approve this in the browser with a passkey \(code [A-Z2-9]{8}\)/u);
      const row = issuer.db.prepare("SELECT canonical_name FROM entity WHERE canonical_name = 'Orrery'").get();
      expect(row).toEqual({ canonical_name: "Orrery" });
    } finally {
      cleanup();
    }
  }, 60_000);

  test("a denied command stops with StepUpError (exit code 5) and changes nothing", async () => {
    const { d, cleanup } = await pcDeps("deny");
    try {
      await expect(adminCall(d, "project-add", { name: "Never", aliases: [] })).rejects.toBeInstanceOf(StepUpError);
      expect(issuer.db.prepare("SELECT count(*) AS n FROM entity WHERE canonical_name = 'Never'").get()).toEqual({ n: 0 });
    } finally {
      cleanup();
    }
  }, 60_000);

  test("mema export writes the project catalog after approval, and never overwrites a file", async () => {
    const { d, cleanup } = await pcDeps("approve");
    const out = path.join(path.dirname(d.paths.tokensFile), "catalog export.json");
    try {
      await exportStore(d, { out, projects: true, includeAuth: false, recipient: undefined });
      expect(JSON.parse(readFileSync(out, "utf8"))).toHaveProperty("projects");
      await expect(exportStore(d, { out, projects: true, includeAuth: false, recipient: undefined })).rejects.toThrow(/exists/u);
    } finally {
      cleanup();
    }
  }, 60_000);
});

describe("connect and ui", () => {
  const healthy = (async () => new Response(JSON.stringify({ ok: true, version: "0.2.0" }))) as unknown as typeof fetch;

  function deps(config: ClientConfigT, paths: CommandDeps["paths"], opened: string[]): CommandDeps {
    return {
      paths, config, store: new StoreClient(config.store.url || undefined, undefined), cwd: process.cwd(), out: () => undefined,
      ask: async (_q, f) => f, now: Date.now, sleep: noWait, openBrowser: async (u) => (opened.push(u), true),
    };
  }

  test("connecting a local-mode PC to a remote store leaves local mode and keeps the local store", async () => {
    const h = tempHome();
    try {
      const toml = 'schema = 1\n[store]\nmode = "local"\nurl = "http://127.0.0.1:47821"\n[repos]\ndeny_remotes = ["github.com/acme/*"]\n';
      mkdirSync(path.dirname(h.paths.clientConfigFile), { recursive: true });
      writeFileSync(h.paths.clientConfigFile, toml);
      const local = parseClientConfig(toml).config;
      const stopped: string[][] = [];
      await connect(deps(local, h.paths, []), "https://memory.example.com/", healthy, (launcher, config) => {
        stopped.push([launcher, config]);
      });
      const after = parseClientConfig(readFileSync(h.paths.clientConfigFile, "utf8")).config;
      expect(after.store).toEqual({ mode: "remote", url: "https://memory.example.com" });
      expect(after.repos.deny_remotes).toEqual(["github.com/acme/*"]);
      expect(stopped).toEqual([[path.join(h.paths.localServerDataDir, "start-hidden.js"), h.paths.localServerConfigFile]]);
      await expect(connect(deps(after, h.paths, []), "http://memory.example.com", healthy)).rejects.toThrow(/https/u);
    } finally {
      h.cleanup();
    }
  });

  test("mema ui opens admin.{host} for a remote store", async () => {
    const h = tempHome();
    try {
      const opened: string[] = [];
      await ui(deps(remoteConfig("https://memory.example.com"), h.paths, opened));
      expect(opened).toEqual(["https://admin.memory.example.com/"]);
    } finally {
      h.cleanup();
    }
  });
});
