// Server-rendered pages (auth-and-security.md §8): consent, setup, recovery, approvals and the
// admin UI. Templates are `eta` files with auto-escaping on, so every stored or client-supplied
// string (a client name, a redirect, memory text) is inserted as text, never as markup. Each page
// loads one first-party script and stylesheet from `/assets/`; nothing inline, nothing third-party.
//
// Every state-changing request from a page carries the page's CSRF token in `X-MA-CSRF` and must
// come from the same origin (`Sec-Fetch-Site: same-origin`, or a matching `Origin`).

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Eta } from "eta";

const WEB_DIR = import.meta.dirname;

const eta = new Eta({ views: path.join(WEB_DIR, "templates"), autoEscape: true, cache: true, useWith: false });

/** The header block every HTML response sends (§8). */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
};

export interface PageData {
  readonly title: string;
  /** Which behaviour app.js wires up (data-page on <body>). */
  readonly page: string;
  /** The CSRF token the page's requests send back. */
  readonly csrf?: string;
  readonly [key: string]: unknown;
}

export function renderPage(template: string, data: PageData): string {
  return eta.render(template, data);
}

export function sendPage(res: ServerResponse, status: number, template: string, data: PageData, headers: Record<string, string> = {}): void {
  const body = renderPage(template, data);
  res.writeHead(status, { ...PAGE_HEADERS, "content-length": String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

const ASSETS: Readonly<Record<string, string>> = {
  "/assets/app.js": "text/javascript; charset=utf-8",
  "/assets/app.css": "text/css; charset=utf-8",
};
const assetCache = new Map<string, Buffer>();

/** Serves `/assets/app.js` and `/assets/app.css`; returns false for any other path. */
export function serveAsset(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const type = ASSETS[pathname];
  if (!type || req.method !== "GET") return false;
  let body = assetCache.get(pathname);
  if (!body) {
    body = readFileSync(path.join(WEB_DIR, "assets", path.basename(pathname)));
    assetCache.set(pathname, body);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff", "content-length": String(body.length) });
  res.end(body);
  return true;
}

/** A CSRF token bound to one subject (a session, an interaction), derived with the store's cookie secret. */
export function csrfFor(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(`csrf:${subject}`).digest("base64url");
}

/** Same-origin, and carrying the subject's CSRF token in X-MA-CSRF. */
export function csrfOk(req: IncomingMessage, origin: string, secret: string, subject: string): boolean {
  const site = req.headers["sec-fetch-site"];
  const sameOrigin = site === undefined ? req.headers.origin === origin : site === "same-origin";
  const presented = Buffer.from(String(req.headers["x-ma-csrf"] ?? ""));
  const expected = Buffer.from(csrfFor(secret, subject));
  return sameOrigin && presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Reads a small JSON body (pages post at most a WebAuthn response). */
export async function readPageJson(req: IncomingMessage, max = 16 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  try {
    const v: unknown = size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
