// The admin UI in local mode (auth-and-security.md §8.1): the same pages at
// http://127.0.0.1:<port>/admin/, with no passkeys, because the local token is the owner credential
// (topology-and-ipc.md §4). `mema ui` turns the token into a browser session through a one-time link:
//
//   mema ui ── POST /admin/link (Bearer <local token>) ──► one-time code (60 s)
//   browser ── GET /admin/login?code=… ──► session cookie ma_admin_local (HttpOnly, SameSite=Strict, Path=/admin) ──► /admin/

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { OwnerCredentials } from "../auth/owner.ts";
import type { FrontDoor } from "../http/front.ts";
import type { Mount, RequestLog } from "../http/server.ts";
import { NO_OUTBOX } from "../ops/outbox.ts";
import { prepared } from "../store/db.ts";
import { csrfFor, sendJson, sendPage, serveAsset } from "../web/pages.ts";
import { sha256Hex } from "../auth/adapter.ts";
import { adminUi } from "./ui.ts";

export const LOCAL_ADMIN_COOKIE = "ma_admin_local";
const ROOT = "/admin";
const LINK_MS = 60_000;

export function localAdmin(o: { app: App; door: FrontDoor; localToken: string }): Mount {
  const { app, door } = o;
  const owner = new OwnerCredentials(app.ctx, NO_OUTBOX, app.alerts);
  const secret = (prepared(app.ctx.db, "SELECT value FROM meta WHERE key = 'cookie_secret'").get() as { value: string }).value;
  const csrfOf = (idHash: string): string => csrfFor(secret, `admin:${idHash}`);
  const ui = adminUi({ app, owner, origin: door.baseUrl, secret, csrfOf, root: ROOT, sessionCookie: LOCAL_ADMIN_COOKIE, local: true });
  const expected = Buffer.from(o.localToken, "utf8");
  /** One-time codes and when each stops working; memory only. */
  const links = new Map<string, number>();

  const bearerOk = (req: IncomingMessage): boolean => {
    const presented = Buffer.from(/^Bearer (\S+)$/u.exec(req.headers.authorization ?? "")?.[1] ?? "", "utf8");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  };

  return {
    serve(req: IncomingMessage, res: ServerResponse, _arrival, log: RequestLog): boolean {
      const url = new URL(req.url ?? "/", door.baseUrl);
      const path = url.pathname;
      if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return false;
      const finish = (status: number, op: string): void => log.finish(status, { op });
      const now = app.ctx.clock.now();

      if (req.method === "POST" && path === `${ROOT}/link`) {
        if (!bearerOk(req)) {
          sendJson(res, 401, { error: "unauthorized" });
          finish(401, "admin_link");
          return true;
        }
        for (const [c, until] of links) if (until <= now) links.delete(c);
        const code = randomBytes(32).toString("base64url");
        links.set(sha256Hex(code), now + LINK_MS);
        sendJson(res, 200, { url: `${door.baseUrl}${ROOT}/login?code=${code}` });
        finish(200, "admin_link");
        return true;
      }
      if (req.method === "GET" && path === `${ROOT}/login`) {
        const key = sha256Hex(url.searchParams.get("code") ?? "");
        const until = links.get(key);
        links.delete(key);
        if (until === undefined || until <= now) {
          sendPage(res, 400, "admin-empty", { title: "Link expired", page: "admin", nav: [], root: ROOT, message: "This link has expired. Run mema ui again." });
          finish(400, "admin_login");
          return true;
        }
        const value = owner.startSession();
        res.writeHead(303, { location: `${ROOT}/`, "set-cookie": `${LOCAL_ADMIN_COOKIE}=${value}; Path=${ROOT}; HttpOnly; SameSite=Strict`, "cache-control": "no-store" });
        res.end();
        finish(303, "admin_login");
        return true;
      }
      if (serveAsset(req, res, path.slice(ROOT.length))) {
        finish(200, "asset");
        return true;
      }
      const served = ui(req, res);
      if (served === undefined) {
        sendJson(res, 404, { error: "not_found" });
        finish(404, "admin_ui");
        return true;
      }
      Promise.resolve(served).then((status) => finish(status, "admin_ui"), () => {
        if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
        finish(500, "admin_ui");
      });
      return true;
    },
  };
}
