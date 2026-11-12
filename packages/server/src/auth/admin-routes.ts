// The owner's surface on https://admin.{host} (auth-and-security.md §2, §3, §8): setup,
// recovery, sign-in, step-up, and opening pairing windows. The admin UI pages (P4) build on the
// same session and CSRF rules.
//
//   GET  /setup  POST /setup/{options, verify, confirm}     first passkeys, recovery codes (token in the body)
//   GET  /recover  POST /recover                              a recovery code opens a new enrollment
//   POST /api/login/{options, verify}                         passkey sign-in → __Host-ma_admin
//   POST /api/stepup/{options, verify}                        a fresh user-verified assertion (5 min)
//   POST /api/windows                                         open a pairing window (step-up)
//   POST /api/logout
//   GET  /approve/:id  POST /approve/:id/{options, approve, deny}   a CLI owner command (§6.2)
//
// Every POST must come from this origin. Requests with a session also carry X-MA-CSRF, an HMAC of
// the session id with the store's cookie secret; setup and recovery carry their own secret token.

import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Arrival, FrontDoor } from "../http/front.ts";
import { ipPrefix } from "../http/log.ts";
import { RateLimiter } from "../http/rate.ts";
import type { Mount, RequestLog } from "../http/server.ts";
import { DAY_MS, HOUR_MS } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { cookies, csrfFor, csrfOk, readPageJson, sendJson, sendPage, serveAsset } from "../web/pages.ts";
import { activeClientFor, createStaticClient } from "./clients.ts";
import { ADMIN_COOKIE, STEP_UP_MS, type OwnerCredentials } from "./owner.ts";
import type { Pairing } from "./pairing.ts";
import type { StepUps } from "./stepup.ts";
import { secondPasskeyOk, type Passkeys } from "./passkeys.ts";
import { isVendor, VENDORS, type Method } from "./vendors.ts";
import { sha256Hex } from "./adapter.ts";

const AUTH_FAIL_WINDOW_MS = 10 * 60_000;
const AUTH_FAIL_LIMIT = 5;

export interface AdminRoutesOptions {
  readonly app: App;
  readonly door: FrontDoor;
  readonly provider: Provider;
  readonly pairing: Pairing;
  readonly passkeys: Passkeys;
  readonly owner: OwnerCredentials;
  readonly stepUps: StepUps;
}

const APPROVE_PAGE = /^\/approve\/(stp_[0-9A-HJKMNP-TV-Z]{26})$/u;
const APPROVE_ACTION = /^\/approve\/(stp_[0-9A-HJKMNP-TV-Z]{26})\/(options|approve|deny)$/u;
const POSTS = /^\/(?:setup\/(?:options|verify|confirm)|recover|api\/(?:login|stepup)\/(?:options|verify)|api\/windows|api\/logout|approve\/stp_[0-9A-HJKMNP-TV-Z]{26}\/(?:options|approve|deny))$/u;

export function adminRoutes(o: AdminRoutesOptions): Mount {
  const { app, door, provider, pairing, passkeys, owner, stepUps } = o;
  const now = (): number => app.ctx.clock.now();
  const origin = door.adminUrl;
  const secret = (prepared(app.ctx.db, "SELECT value FROM meta WHERE key = 'cookie_secret'").get() as { value: string }).value;
  const limits = app.config.rate_limits;
  const loginLimit = new RateLimiter(limits.login_per_ip_per_min, 60_000, now);
  const recoverPerIp = new RateLimiter(limits.recover_per_ip_per_hour, HOUR_MS, now);
  const recoverGlobal = new RateLimiter(10, DAY_MS, now);
  /** Failed sign-ins and recovery attempts in the last 10 minutes (alert `auth_fail` at 5). */
  const failures: number[] = [];

  const sessionCookie = (value: string): string => `${ADMIN_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  const csrfOf = (idHash: string): string => csrfFor(secret, `admin:${idHash}`);
  const sameOrigin = (req: IncomingMessage): boolean => {
    const site = req.headers["sec-fetch-site"];
    return site === undefined ? req.headers.origin === origin : site === "same-origin";
  };

  function failed(): void {
    const t = now();
    failures.push(t);
    while (failures.length > 0 && (failures[0] ?? t) <= t - AUTH_FAIL_WINDOW_MS) failures.shift();
    if (failures.length >= AUTH_FAIL_LIMIT) app.alerts.raise("auth_fail", { attempts: failures.length });
  }

  async function post(req: IncomingMessage, res: ServerResponse, path: string, ip: string, json: (status: number, body: unknown, headers?: Record<string, string>) => void): Promise<void> {
    if (!sameOrigin(req)) return json(403, { error: "cross_origin" });
    const body = (await readPageJson(req)) ?? {};

    // ---- setup and recovery: no session; the token or code in the body is the proof ----
    if (path === "/setup/options" || path === "/setup/verify" || path === "/setup/confirm") {
      const token = String(body["token"] ?? "");
      // Enrolling needs fewer than two passkeys; the final confirmation only needs the token itself.
      if (!(path === "/setup/confirm" ? owner.setupTokenUnused(token) : owner.setupTokenValid(token))) return json(403, { error: "setup_unavailable" });
      const purpose = `setup:${sha256Hex(token).slice(0, 32)}`;
      if (path === "/setup/options") return json(200, await passkeys.registrationOptions(purpose));
      if (path === "/setup/verify") {
        const p = await passkeys.verifyRegistration(purpose, body["response"] as never);
        if (!p) return json(400, { error: "registration_failed" });
        const existing = passkeys.list();
        const first = existing[0];
        if (first && !secondPasskeyOk({ aaguid: first.aaguid, backupEligible: first.backup_eligible === 1 }, p, body["differentProviders"] === true)) {
          return json(409, { error: "same_provider" });
        }
        owner.createOwner();
        passkeys.store(p, String(body["label"] ?? (first ? "Second passkey" : "First passkey")));
        if (!first) return json(200, { next: "second_passkey" });
        return json(200, { next: "confirm_code", codes: await owner.newRecoveryCodes() });
      }
      // confirm: two passkeys exist and the owner typed one recovery code back (§3.1 step 4).
      if (passkeys.count() < 2 || !(await owner.checkRecoveryCode(String(body["code"] ?? ""), false))) return json(403, { error: "code_mismatch" });
      owner.finishSetup(token);
      const value = owner.startSession();
      return json(200, { ok: true, csrf: csrfOf(sha256Hex(value)) }, { "set-cookie": sessionCookie(value) });
    }
    if (path === "/recover") {
      if (recoverPerIp.take(ip) > 0 || recoverGlobal.take("all") > 0) return json(429, { error: "rate_limited" });
      if (!(await owner.checkRecoveryCode(String(body["code"] ?? ""), true))) {
        failed();
        return json(403, { error: "wrong_code" });
      }
      return json(200, { enroll: `/setup#${owner.recover()}` });
    }

    // ---- sign-in ----
    if (path === "/api/login/options" || path === "/api/login/verify") {
      if (loginLimit.take(ip) > 0) return json(429, { error: "rate_limited" });
      if (path === "/api/login/options") return json(200, await passkeys.assertionOptions("login"));
      if (!(await passkeys.verify("login", body as never))) {
        failed();
        return json(403, { error: "passkey_failed" });
      }
      const value = owner.startSession();
      return json(200, { ok: true, csrf: csrfOf(sha256Hex(value)) }, { "set-cookie": sessionCookie(value) });
    }

    // ---- everything else needs a session and its CSRF token ----
    const session = owner.session(cookies(req)[ADMIN_COOKIE]);
    if (!session) return json(401, { error: "login_required" });
    if (!csrfOk(req, origin, secret, `admin:${session.idHash}`)) return json(403, { error: "csrf" });
    if (path === "/api/logout") {
      owner.endSession(session.idHash);
      return json(200, { ok: true }, { "set-cookie": `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (path === "/api/stepup/options") return json(200, await passkeys.assertionOptions(`stepup:${session.idHash}`));
    if (path === "/api/stepup/verify") {
      if (!(await passkeys.verify(`stepup:${session.idHash}`, body as never))) {
        failed();
        return json(403, { error: "passkey_failed" });
      }
      owner.markVerified(session.idHash);
      return json(200, { ok: true });
    }
    const approve = APPROVE_ACTION.exec(path);
    if (approve?.[1]) {
      const id = approve[1];
      const purpose = `approve:${id}:${session.idHash}`;
      if (approve[2] === "options") return json(200, await passkeys.assertionOptions(purpose));
      if (approve[2] === "deny") {
        stepUps.deny(id);
        return json(200, { ok: true });
      }
      // Approving is one of the §3.4 actions: the passkey assertion here is the fresh user verification.
      if (!(await passkeys.verify(purpose, body["response"] as never))) {
        failed();
        return json(403, { error: "passkey_failed" });
      }
      owner.markVerified(session.idHash);
      const r = stepUps.approve(id, typeof body["confirm"] === "string" ? body["confirm"] : undefined);
      return r === "approved" || r === "second" ? json(200, { result: r }) : json(409, { error: r });
    }
    if (path === "/api/windows") {
      if (now() - session.uvAt > STEP_UP_MS) return json(401, { error: "step_up_required" });
      if (passkeys.count() < 2) return json(409, { error: "second_passkey_required" });
      return openWindow(body, json);
    }
    return json(404, { error: "not_found" });
  }

  async function openWindow(body: Record<string, unknown>, json: (status: number, body: unknown, headers?: Record<string, string>) => void): Promise<void> {
    const vendor = body["vendor"];
    const method = body["method"] as Method;
    if (!isVendor(vendor) || !VENDORS[vendor].methods.includes(method)) return json(400, { error: "bad_vendor_or_method" });
    const machineName = vendor === "pc" ? String(body["machineName"] ?? "").trim().slice(0, 40) : undefined;
    if (vendor === "pc" && !machineName) return json(400, { error: "machine_name_required" });
    const otherHost = vendor === "other" && typeof body["otherHost"] === "string" ? body["otherHost"].trim().toLowerCase() : undefined;
    if (vendor === "other" && !(otherHost && /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(otherHost))) return json(400, { error: "other_host_required" });
    // One active grant per vendor (per machine for the PC): pairing again needs "Replace" (§4.1).
    const current = activeClientFor(app.ctx, vendor, machineName);
    if (current && body["replace"] !== true) return json(409, { error: "replace_required", client: current });
    const { window, cookieToken } = pairing.open(vendor, method, {
      ...(otherHost ? { otherHost } : {}),
      ...(machineName ? { machineName } : {}),
      ...(current ? { replacesClientId: current } : {}),
      desktop: body["desktop"] === true,
      write: body["write"] !== false,
    });
    let credentials: Awaited<ReturnType<typeof createStaticClient>>;
    if (method === "static" && vendor !== "pc") {
      const otherRedirect = typeof body["redirectUri"] === "string" && otherHost && URL.parse(body["redirectUri"])?.hostname === otherHost ? body["redirectUri"] : undefined;
      credentials = await createStaticClient(provider, vendor, otherRedirect);
      if (!credentials) {
        pairing.close(window.id, "cancelled");
        return json(400, { error: "redirect_uri_required" });
      }
      pairing.attachClient(window.id, credentials.client_id);
    }
    return json(200, {
      window_id: window.id,
      pair_code: window.pair_code,
      expires_at: window.expires_at,
      mcp_url: `${door.baseUrl}/mcp`,
      pair_link: `${door.baseUrl}/pair/${window.id}?t=${cookieToken}`,
      ...(credentials ? { credentials } : {}),
    });
  }

  return {
    serve(req: IncomingMessage, res: ServerResponse, arrival: Arrival, log: RequestLog): boolean {
      const path = new URL(req.url ?? "/", origin).pathname;
      const finish = (status: number, op: string): void => log.finish(status, { op });
      if (serveAsset(req, res, path)) {
        finish(200, "asset");
        return true;
      }
      const approvePage = APPROVE_PAGE.exec(path);
      if (req.method === "GET" && approvePage?.[1]) {
        const session = owner.session(cookies(req)[ADMIN_COOKIE]);
        // An unknown request looks like a closed one. Without a session the page signs the owner in first.
        const view = stepUps.view(approvePage[1]);
        sendPage(res, 200, "approve", {
          title: "Approve command",
          page: session ? "approve" : "signin",
          csrf: session ? csrfOf(session.idHash) : "",
          base: `/approve/${approvePage[1]}`,
          signedIn: session !== undefined,
          lines: view?.text.split("\n") ?? [],
          userCode: view?.userCode ?? "",
          open: view?.open ?? false,
          needsSecondConfirm: view?.needsSecondConfirm ?? false,
        });
        finish(200, "approve");
        return true;
      }
      if (req.method === "GET" && (path === "/setup" || path === "/recover")) {
        const page = path.slice(1);
        sendPage(res, 200, page, { title: page === "setup" ? "Set up" : "Recover", page });
        finish(200, page);
        return true;
      }
      if (req.method === "POST" && POSTS.test(path)) {
        const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
          sendJson(res, status, body, headers);
          finish(status, path.replace(/^\/(api\/)?/u, "").replaceAll("/", "_"));
        };
        post(req, res, path, ipPrefix(arrival.clientIp) ?? "unknown", json).catch(() => {
          if (!res.headersSent) json(500, { error: "server_error" });
        });
        return true;
      }
      return false;
    },
  };
}
