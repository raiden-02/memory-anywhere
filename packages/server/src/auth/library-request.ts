// Reading and answering requests inside the OAuth library's middleware (oidc-provider runs on Koa).

import type { IncomingMessage } from "node:http";
import type Provider from "oidc-provider";
import { PAGE_HEADERS } from "../web/pages.ts";
import { ERROR_PAGE } from "./provider.ts";

/** The Koa context the library hands its middleware. */
export type Ctx = Parameters<Parameters<Provider["use"]>[0]>[0];

const BODY_LIMIT = 56 * 1024;
const INVALID_REQUEST = JSON.stringify({ error: "invalid_request" });

/** The raw request body, read once and kept on the request so the library can read it again. */
export async function providerBody(c: Ctx): Promise<string> {
	const req = c.req as IncomingMessage & { body?: string };
	if (req.body !== undefined) return req.body;
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error("request body too large");
		chunks.push(chunk);
	}
	req.body = Buffer.concat(chunks).toString("utf8");
	return req.body;
}

/** A JSON object or form body as key-value pairs; undefined when it is neither. */
export function parseBody(req: IncomingMessage, raw: string | undefined): Record<string, unknown> | undefined {
	if (raw === undefined) return undefined;
	const type = req.headers["content-type"] ?? "";
	try {
		if (type.startsWith("application/json")) {
			const v: unknown = raw ? JSON.parse(raw) : {};
			return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
		}
		if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
	} catch {
		return undefined;
	}
	return undefined;
}

/** The one failure response of /oauth/reg (auth-and-security.md §4.1 step 4). */
export function rejectJson(c: Ctx): void {
	for (const h of Object.keys(c.response.headers)) c.remove(h);
	c.status = 400;
	c.type = "application/json; charset=utf-8";
	c.set("cache-control", "no-store");
	c.body = INVALID_REQUEST;
}

/** The one failure response of /oauth/auth: the error page, never a redirect. */
export function rejectPage(c: Ctx): void {
	for (const h of Object.keys(c.response.headers)) c.remove(h);
	c.status = 400;
	c.type = "text/html; charset=utf-8";
	c.set(PAGE_HEADERS);
	c.body = ERROR_PAGE;
}
