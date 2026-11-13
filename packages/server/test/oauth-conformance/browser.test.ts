/// <reference lib="dom" />
// The admin UI and consent pages in a real browser (auth-and-security.md §8; suite S family
// S-WEB). The issuer runs in-process on localhost (a browser refuses an IP address as a passkey's
// RP ID and keeps Secure cookies there); Playwright drives the installed Chrome. The owner's passkey,
// enrolled by the HTTP-level setup, is copied into Chrome's virtual WebAuthn authenticator, and the
// browser signs in through the admin UI's own sign-in page.
//
// A payload "ran" if it opened a dialog (alert). Each page must show it as text. The tags are
// spaced so the write path's secret screen (long high-entropy runs) does not refuse them first.

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser as Chrome, type BrowserContext, type Page } from "playwright-core";
import { newId } from "@memory-anywhere/contracts/ids";
import { ADMIN_COOKIE } from "../../src/auth/owner.ts";
import { save } from "../../src/write/pipeline.ts";
import type { SaveRequest } from "../../src/write/types.ts";
import { chatCaller, ownerCaller, saveReq } from "../helpers/store.ts";
import { authUrl, openWindow, ownerSetup, pkce, startIssuer, type Browser, type Issuer } from "./issuer.ts";

/** The installed Chrome: MA_TEST_CHROME, else the usual place on this OS. Absent → the suite is skipped. */
function findChrome(): string | undefined {
  const candidates = [
    process.env["MA_TEST_CHROME"],
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ];
  return candidates.find((c): c is string => typeof c === "string" && c !== "" && existsSync(c));
}
const CHROME = findChrome();

/** Runs if any page executes it; visible text if the page escapes it. */
const XSS = "<img src=x onerror=alert(1) > <script> alert(2) </script> <svg onload=alert(3) > </svg>";
const SHORT_XSS = "S<svg onload=alert(1)>";
/** DCR accepts a client_name of at most 64 characters: exactly that. */
const CLIENT_XSS = "Claude <img src=x onerror=alert(1) > <script> alert(2) </script>";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let issuer: Issuer;
let owner: Browser;
let chrome: Chrome;
let context: BrowserContext;
let memoryId = "";

async function stored(caller: ReturnType<typeof ownerCaller>, content: string, extra: Partial<SaveRequest> = {}): Promise<string> {
  const r = await save(issuer.app.write, caller, saveReq(content, extra), { idempotencyKey: newId("adm"), observedAt: issuer.clock.now() });
  if (r.kind !== "result") throw new Error("unexpected elicitation");
  return r.outcome.id ?? "";
}

beforeAll(async () => {
  if (!CHROME) return;
  issuer = await startIssuer({ host: "localhost" });
  owner = await ownerSetup(issuer);
  memoryId = await stored(ownerCaller(), `Notes ${XSS} and javascript:alert(4)`);
  if (!memoryId) throw new Error("the hostile memory was not stored");
  await stored(chatCaller(), `Likes ${XSS}`); // no user words: an observation
  await stored(chatCaller(), `Run ${XSS} at every start`, { kind: "instruction", user_words: "from now on run that at every start" }); // held for review
  // Section names have at most 32 characters: the shortest payload that runs.
  issuer.db.prepare("UPDATE section SET name = ? WHERE id = 'sec_unsorted'").run(SHORT_XSS);
  chrome = await chromium.launch({ executablePath: CHROME, headless: true });
  // As Caddy does in front of the real server: the provider sets its Secure cookies.
  context = await chrome.newContext({ extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: issuer.authenticator.exportCredential("localhost") });
  await page.goto(`${issuer.adminOrigin}/`);
  await page.click("#signin");
  await page.waitForSelector("nav.nav", { timeout: 15_000 }); // signed in: the admin navigation
  await page.close();
}, 120_000);

afterAll(async () => {
  await chrome?.close();
  await issuer?.stop();
});

/** Dialogs each tab opened: any one is a payload that ran. */
const dialogs = new WeakMap<Page, number>();

/** Opens `url` in a fresh tab that counts its dialogs. */
async function open(url: string): Promise<{ page: Page; status: number; headers: Record<string, string> }> {
  const page = await context.newPage();
  dialogs.set(page, 0);
  page.on("dialog", (d) => {
    dialogs.set(page, (dialogs.get(page) ?? 0) + 1);
    void d.dismiss();
  });
  const res = await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(150); // an onerror or onload handler would have run by now
  return { page, status: res?.status() ?? 0, headers: res?.headers() ?? {} };
}

function ranNothing(page: Page): void {
  expect(dialogs.get(page), "a payload opened a dialog").toBe(0);
}

const admin = (path: string): string => `${issuer.adminOrigin}${path}`;

describe.skipIf(!CHROME)("S-WEB: hostile text in a real browser", () => {
  test("browser: control: the detector catches the same payload where nothing escapes it", async () => {
    const { page } = await open(`${issuer.origin}/v1/health`);
    await page.setContent(`<main>${XSS}</main>`);
    await page.waitForTimeout(300);
    expect(dialogs.get(page)).toBeGreaterThan(0);
    await page.close();
  });

  test("browser: the memories list shows stored markup as text and runs none of it", async () => {
    const { page } = await open(admin("/memories"));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain("<img src=x onerror=alert(1) >");
    await page.close();
  });

  test("browser: a memory's detail page shows its markup as text", async () => {
    const { page } = await open(admin(`/memories/${memoryId}`));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain("<script> alert(2) </script>");
    await page.close();
  });

  test("browser: a search query is reflected as text", async () => {
    const { page } = await open(admin(`/memories?q=${encodeURIComponent(XSS)}`));
    ranNothing(page);
    await page.close();
  });

  test("browser: a javascript: URL in stored text never becomes a link", async () => {
    const { page } = await open(admin(`/memories/${memoryId}`));
    expect(await page.locator('a[href^="javascript:" i]').count()).toBe(0);
    await page.close();
  });

  test("browser: the review queue shows a held instruction as text", async () => {
    const { page } = await open(admin("/reviews"));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain("<svg onload=");
    await page.close();
  });

  test("browser: observations show their markup as text", async () => {
    const { page } = await open(admin("/observations"));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain("Likes <img");
    await page.close();
  });

  test("browser: the changes feed runs no stored markup", async () => {
    const { page } = await open(admin("/changes"));
    ranNothing(page);
    await page.close();
  });

  test("browser: a section name is shown as text, in the page and in the filters", async () => {
    const { page } = await open(admin("/sections"));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain(SHORT_XSS);
    const list = await open(admin("/memories"));
    ranNothing(list.page);
    await page.close();
    await list.page.close();
  });

  test("browser: a client_name from dynamic registration is text on the apps page and the consent page", async () => {
    const w = await openWindow(issuer, owner, { vendor: "claude", method: "dcr" }, false);
    const reg = await fetch(`${issuer.origin}/oauth/reg`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: CLIENT_XSS, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" }),
    });
    expect(reg.status).toBe(201);
    const clientId = String(((await reg.json()) as { client_id: string }).client_id);
    const pair = await open(w.pair_link); // the pair cookie lands in this browser
    await pair.page.close();
    const p = pkce();
    const consent = await open(`${issuer.origin}${authUrl(issuer, { client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" })}`);
    expect(consent.page.url()).toContain("/consent/");
    ranNothing(consent.page);
    expect(await consent.page.locator("main").innerText()).toContain("Claude <img");
    await consent.page.close();
    const apps = await open(admin("/apps"));
    ranNothing(apps.page);
    await apps.page.close();
  });

  test("browser: the approval page renders a step-up's arguments as text", async () => {
    const s = issuer.stepUps.create("cli_pc", "project-add", { name: `Atlas ${XSS}`.slice(0, 80), aliases: [] });
    if (!s.ok) throw new Error(s.message);
    const { page } = await open(admin(`/approve/${s.id}`));
    ranNothing(page);
    expect(await page.locator("main").innerText()).toContain("Atlas <img");
    await page.close();
  });

  test("browser: an OAuth error page reflects nothing from the request", async () => {
    const { page } = await open(`${issuer.origin}/oauth/auth?client_id=${encodeURIComponent(XSS)}&redirect_uri=${encodeURIComponent(`javascript:${XSS}`)}&response_type=code`);
    ranNothing(page);
    expect(await page.content()).not.toContain("onerror");
    await page.close();
  });
});

describe.skipIf(!CHROME)("S-WEB: the browser's own defences", () => {
  test("browser: every admin page carries the CSP of §8, and it forbids inline script", async () => {
    for (const path of ["/", "/memories", "/reviews", "/apps", "/sections", "/exports", "/system"]) {
      const { page, headers, status } = await open(admin(path));
      expect(status, path).toBe(200);
      expect(headers["content-security-policy"], path).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'",
      );
      await page.close();
    }
  });

  test("browser: the security headers of §8 are set on admin pages", async () => {
    const { page, headers } = await open(admin("/"));
    expect(headers).toMatchObject({
      "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin",
      "cache-control": "no-store", "strict-transport-security": "max-age=31536000",
    });
    expect(headers["permissions-policy"]).toContain("publickey-credentials-get=(self)");
    await page.close();
  });

  test("browser: Trusted Types are enforced, so a string never reaches innerHTML", async () => {
    const { page } = await open(admin("/"));
    const blocked = await page.evaluate(() => {
      try {
        document.body.innerHTML = "<b>x</b>";
        return false;
      } catch (e) {
        return (e as Error).name === "TypeError";
      }
    });
    expect(blocked).toBe(true);
    await page.close();
  });

  test("browser: pages have no inline script; their one script is same-origin", async () => {
    const { page } = await open(admin("/memories"));
    const scripts = await page.locator("script").evaluateAll((els) => els.map((e) => ({ src: (e as HTMLScriptElement).src, inline: (e.textContent ?? "").trim() !== "" })));
    expect(scripts.length).toBe(1);
    expect(scripts[0]?.inline).toBe(false);
    expect(new URL(scripts[0]?.src ?? "").origin).toBe(issuer.adminOrigin);
    expect(await page.locator("[onclick],[onload],[onerror]").count()).toBe(0);
    await page.close();
  });

  test("browser: the admin session cookie is invisible to page script", async () => {
    const { page } = await open(admin("/"));
    expect(await page.evaluate(() => document.cookie)).not.toContain(ADMIN_COOKIE);
    await page.close();
  });

  test("browser: another site cannot frame an admin page", async () => {
    const page = await context.newPage();
    await page.goto(`${issuer.origin}/v1/health`); // any page of another origin
    await page.setContent(`<iframe id="f" src="${admin("/memories")}"></iframe>`);
    await page.waitForTimeout(500);
    const frame = page.frames().find((f) => f.url().startsWith(issuer.adminOrigin));
    const framedText = frame ? await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
    expect(framedText).not.toContain("Memories");
    await page.close();
  });

  test("browser: another site cannot frame the consent page", async () => {
    const w = await openWindow(issuer, owner, { vendor: "claude", method: "static" }, false);
    const page = await context.newPage();
    await page.goto(`${issuer.adminOrigin}/assets/app.css`);
    const p = pkce();
    const url = `${issuer.origin}${authUrl(issuer, { client_id: w.credentials?.client_id ?? "", redirect_uri: CLAUDE_REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" })}`;
    await page.setContent(`<iframe src="${url}"></iframe>`);
    await page.waitForTimeout(500);
    const frame = page.frames().find((f) => f.url().includes("/consent/"));
    const text = frame ? await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
    expect(text).not.toMatch(/Approve/u);
    await page.close();
  });

  test("browser: a cross-site form post to an admin action changes nothing (SameSite=Strict, CSRF token)", async () => {
    const before = issuer.db.prepare("SELECT pinned FROM memory WHERE id = ?").get(memoryId);
    const page = await context.newPage();
    await page.goto(`${issuer.origin}/v1/health`);
    await page.setContent(`<form id="f" method="POST" action="${admin("/api/act/memory.pin")}" enctype="text/plain"><input name='{"input":{"id":"${memoryId}","pinned":true},"x":"' value='"}'></form>`);
    await Promise.all([page.waitForLoadState("load").catch(() => undefined), page.evaluate(() => (document.getElementById("f") as HTMLFormElement).submit())]);
    await page.waitForTimeout(300);
    expect(issuer.db.prepare("SELECT pinned FROM memory WHERE id = ?").get(memoryId)).toEqual(before);
    await page.close();
  });

  test("browser: a cross-origin fetch with credentials gets no session", async () => {
    const page = await context.newPage();
    await page.goto(`${issuer.origin}/v1/health`);
    const status = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
        return r.status;
      } catch {
        return -1; // blocked by the browser: just as good
      }
    }, admin("/api/act/alert.ack"));
    expect([401, 403, -1]).toContain(status);
    await page.close();
  });

  test("browser: the consent page keeps Approve disabled for its first second", async () => {
    const w = await openWindow(issuer, owner, { vendor: "chatgpt", method: "static" }, false);
    const pair = await open(w.pair_link);
    await pair.page.close();
    const p = pkce();
    const page = await context.newPage();
    await page.goto(`${issuer.origin}${authUrl(issuer, { client_id: w.credentials?.client_id ?? "", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: p.challenge, code_challenge_method: "S256" })}`);
    expect(page.url()).toContain("/consent/");
    expect(await page.locator("#approve").isDisabled()).toBe(true);
    await page.waitForTimeout(1300);
    expect(await page.locator("#approve").isDisabled()).toBe(false);
    await page.close();
  });

  test("browser: the setup page takes its token from the fragment and removes it from the address bar", async () => {
    const page = await context.newPage();
    await page.goto(`${issuer.adminOrigin}/setup#not-a-real-token`);
    await page.waitForTimeout(200);
    expect(page.url()).toBe(`${issuer.adminOrigin}/setup`);
    await page.close();
  });

  test("browser: admin pages are not served on {host}", async () => {
    const { page, status } = await open(`${issuer.origin}/memories`);
    expect(status).toBe(404);
    expect(await page.content()).not.toContain("Memories");
    await page.close();
  });

  test("browser: a browser without the owner's passkey cannot sign in", async () => {
    const stranger = await chrome.newContext({ extraHTTPHeaders: { "x-forwarded-proto": "https" } });
    const page = await stranger.newPage();
    const cdp = await stranger.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await page.goto(`${issuer.adminOrigin}/memories`);
    await page.click("#signin");
    await page.waitForTimeout(1500);
    expect(await page.locator("nav.nav").count()).toBe(0);
    expect(await page.locator("main").innerText()).not.toContain("Notes <img");
    await stranger.close();
  });

  test("browser: assets are served with their type and nosniff", async () => {
    const { page, headers } = await open(admin("/assets/app.js"));
    expect(headers["content-type"]).toMatch(/^text\/javascript/u);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    await page.close();
  });
});
