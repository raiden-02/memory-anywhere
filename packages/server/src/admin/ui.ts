// The admin UI's pages and action endpoint on admin.{host} (auth-and-security.md §8.1).
//
//   GET  /                     home: alerts, a pending owner reset, what needs attention
//   GET  /memories[?q,section,status,page]   GET /memories/:id
//   GET  /reviews  /observations  /changes  /apps  /sections  /repos  /exports  /system
//   POST /api/act/:action      one owner action (owner-actions.ts), JSON {input}
//   POST /api/reset/cancel     cancel a pending owner reset
//   POST /api/selfcheck  GET /api/selfcheck   eval stacks only: ask for the on-instance checks, read the result
//
// Every page needs the admin session; without one the sign-in page is shown. Every action carries
// the session's CSRF token, and §3.4 actions need a passkey within the last 5 minutes: the endpoint
// answers `step_up_required` and the page asks for the passkey, then retries.
//
// Local mode serves the same pages under /admin on 127.0.0.1 (local-ui.ts): there the session comes
// from `mema ui`'s one-time link, the local token being the owner credential, and no passkey exists.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { App } from "../app.ts";
import { ADMIN_COOKIE, STEP_UP_MS, type OwnerCredentials } from "../auth/owner.ts";
import { VENDORS } from "../auth/vendors.ts";
import { cookies, csrfOk, readPageJson, sendJson, sendPage } from "../web/pages.ts";
import { ActionError, isAction, needsUv, runAction } from "./owner-actions.ts";
import { parseRequest, selfcheckFiles } from "../ops/selfcheck.ts";
import * as views from "./views.ts";

export interface AdminUiOptions {
  readonly app: App;
  readonly owner: OwnerCredentials;
  /** The admin origin, for the same-origin check. */
  readonly origin: string;
  readonly secret: string;
  readonly csrfOf: (idHash: string) => string;
  /** Path prefix: "" on admin.{host}, "/admin" on the local server. */
  readonly root?: string;
  /** The session cookie: `__Host-ma_admin` (aws) or `ma_admin_local` (local). */
  readonly sessionCookie?: string;
  /** Local mode: no passkeys, so step-up is always satisfied and pairing is hidden. */
  readonly local?: boolean;
}

const PAGES = ["/", "/memories", "/reviews", "/observations", "/changes", "/apps", "/sections", "/repos", "/exports", "/system"] as const;
const NAV: readonly { path: string; label: string }[] = [
  { path: "/", label: "Home" }, { path: "/memories", label: "Memories" }, { path: "/reviews", label: "Review" }, { path: "/observations", label: "Observations" },
  { path: "/changes", label: "Changes" }, { path: "/apps", label: "Apps" }, { path: "/sections", label: "Sections" }, { path: "/repos", label: "Repos" },
  { path: "/exports", label: "Exports" }, { path: "/system", label: "System" },
];
const MEMORY_PAGE = /^\/memories\/(mem_[0-9A-HJKMNP-TV-Z]{26})$/u;
const ACT = /^\/api\/act\/([a-z]+\.[a-z]+)$/u;

/** Serves a page or action; returns the status, or undefined when the path is not the UI's. */
export function adminUi(o: AdminUiOptions): (req: IncomingMessage, res: ServerResponse) => number | Promise<number> | undefined {
  const { app, owner } = o;
  const root = o.root ?? "";
  const cookieName = o.sessionCookie ?? ADMIN_COOKIE;
  const local = o.local === true;

  function page(res: ServerResponse, template: string, title: string, active: string, csrf: string, data: Record<string, unknown>): number {
    sendPage(res, 200, template, { title, page: "admin", csrf, nav: NAV, active, root, local, ...data });
    return 200;
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", o.origin);
    if (root && url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return undefined;
    const path = url.pathname.slice(root.length) || "/";
    const isPage = req.method === "GET" && ((PAGES as readonly string[]).includes(path) || MEMORY_PAGE.test(path));
    const act = req.method === "POST" ? ACT.exec(path) : null;
    const resetCancel = req.method === "POST" && path === "/api/reset/cancel";
    const selfcheck = path === "/api/selfcheck" && (req.method === "POST" || req.method === "GET") ? selfcheckFiles(app.config, app.config.server.data_dir) : undefined;
    if (!isPage && !act && !resetCancel && !selfcheck) return undefined;

    const session = owner.session(cookies(req)[cookieName]);
    if (isPage) {
      if (!session && local) {
        sendPage(res, 200, "admin-empty", { title: "Open with mema ui", page: "admin", nav: [], root, message: "Run mema ui on this computer to open the admin page." });
        return 200;
      }
      if (!session) {
        sendPage(res, 200, "approve", { title: "Sign in", page: "signin", signedIn: false, lines: [], userCode: "", open: false, needsSecondConfirm: false });
        return 200;
      }
      const csrf = o.csrfOf(session.idHash);
      const q = url.searchParams;
      const detail = MEMORY_PAGE.exec(path)?.[1];
      if (detail) {
        const d = views.memoryDetail(app, detail);
        if (!d) return page(res, "admin-empty", "Not found", "/memories", csrf, { message: "No memory with that id." });
        return page(res, "admin-memory", "Memory", "/memories", csrf, d);
      }
      switch (path) {
        case "/": return page(res, "admin-home", "Home", "/", csrf, views.home(app));
        case "/memories": {
          const filters = { text: q.get("q") ?? undefined, section: q.get("section") || undefined, status: q.get("status") || undefined, page: Number(q.get("page") ?? 0) || 0 };
          return page(res, "admin-memories", "Memories", "/memories", csrf, { rows: views.memories(app, filters), filters, sections: views.sectionOptions(app) });
        }
        case "/reviews": return page(res, "admin-reviews", "Review", "/reviews", csrf, views.reviews(app));
        case "/observations": return page(res, "admin-observations", "Observations", "/observations", csrf, { rows: views.observations(app) });
        case "/changes": return page(res, "admin-changes", "Changes", "/changes", csrf, { rows: views.changes(app) });
        case "/apps": return page(res, "admin-apps", "Apps", "/apps", csrf, { rows: views.clients(app), approvals: views.approvals(app), vendors: Object.entries(VENDORS).map(([id, v]) => ({ id, label: v.label, methods: v.methods })) });
        case "/sections": return page(res, "admin-sections", "Sections", "/sections", csrf, views.sections(app));
        case "/repos": return page(res, "admin-repos", "Repos", "/repos", csrf, { rows: views.repos(app) });
        case "/exports": return page(res, "admin-exports", "Exports", "/exports", csrf, views.exportsView(app));
        default: return page(res, "admin-system", "System", "/system", csrf, { spend: views.spend(app), alerts: app.alerts.open(), digestHour: app.config.alerts.digest_hour_local, cap: app.config.llm.daily_usd_cap });
      }
    }

    return (async (): Promise<number> => {
      const json = (status: number, body: unknown): number => {
        sendJson(res, status, body);
        return status;
      };
      if (!session) return json(401, { error: "login_required" });
      if (selfcheck && req.method === "GET") {
        // The result once the root service has written it for the latest request; ids and counts only.
        if (!existsSync(selfcheck.result) || (existsSync(selfcheck.request) && statSync(selfcheck.request).mtimeMs >= statSync(selfcheck.result).mtimeMs)) return json(200, { status: "pending" });
        return json(200, { status: "done", ...(JSON.parse(readFileSync(selfcheck.result, "utf8")) as object) });
      }
      if (!csrfOk(req, o.origin, o.secret, `admin:${session.idHash}`)) return json(403, { error: "csrf" });
      const fresh = local || app.ctx.clock.now() - session.uvAt <= STEP_UP_MS;
      const body = (await readPageJson(req)) ?? {};
      if (resetCancel) {
        if (!fresh) return json(401, { error: "step_up_required" });
        return json(200, { cancelled: owner.cancelReset() });
      }
      if (selfcheck) {
        const request = parseRequest(body);
        if (!request) return json(400, { error: "canaries: 1 to 50 strings of 4 to 100 characters" });
        mkdirSync(dirname(selfcheck.request), { recursive: true, mode: 0o700 });
        writeFileSync(selfcheck.request, JSON.stringify(request), { mode: 0o600 });
        return json(202, { status: "pending" });
      }
      const name = act?.[1] ?? "";
      if (!isAction(name)) return json(404, { error: "not_found" });
      const input = body["input"];
      if (needsUv(app, name, input) && !fresh) return json(401, { error: "step_up_required" });
      try {
        return json(200, { ok: true, result: (await runAction(app, name, input)) ?? null });
      } catch (e) {
        if (e instanceof ActionError) return json(400, { error: e.message });
        throw e;
      }
    })();
  };
}
