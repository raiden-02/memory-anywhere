// The owner's surface on https://admin.{host} (auth-and-security.md §2, §3, §8): setup,
// recovery, sign-in, step-up, and opening pairing windows. The admin UI pages build on the same
// session and CSRF rules.
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

import { ULID_PATTERN } from "@memory-anywhere/contracts/ids";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Arrival, FrontDoor } from "../http/front.ts";
import { ipPrefix } from "../http/log.ts";
import { RateLimiter } from "../http/rate.ts";
import type { Mount, RequestLog } from "../http/server.ts";
import { DAY_MS, HOUR_MS } from "../store/clock.ts";
import { adminUi } from "../admin/ui.ts";
import { cookies, csrfFor, csrfOk, readPageJson, sendJson, sendPage, serveAsset, type Reply } from "../web/pages.ts";
import { sha256Hex } from "./adapter.ts";
import { openWindow } from "./open-window.ts";
import { ADMIN_COOKIE, STEP_UP_MS, type OwnerCredentials } from "./owner.ts";
import { SETUP_PATHS, setupStep } from "./owner-setup.ts";
import type { Pairing } from "./pairing.ts";
import type { Passkeys } from "./passkeys.ts";
import type { StepUps } from "./stepup.ts";
import { requireMeta } from "../store/meta.ts";

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

const APPROVE_PAGE = new RegExp(`^/approve/(stp_${ULID_PATTERN})$`, "u");
const APPROVE_ACTION = new RegExp(`^/approve/(stp_${ULID_PATTERN})/(options|approve|deny)$`, "u");
const POSTS = new RegExp(
	`^/(?:setup/(?:options|verify|confirm)|recover|api/(?:login|stepup)/(?:options|verify)|api/windows|api/logout|approve/stp_${ULID_PATTERN}/(?:options|approve|deny))$`,
	"u",
);

export function adminRoutes(o: AdminRoutesOptions): Mount {
	const { app, door, provider, pairing, passkeys, owner, stepUps } = o;
	const now = (): number => app.ctx.clock.now();
	const origin = door.adminUrl;
	const secret = requireMeta(app.ctx.db, "cookie_secret");
	const limits = app.config.rate_limits;
	const loginLimit = new RateLimiter(limits.login_per_ip_per_min, 60_000, now);
	const recoverPerIp = new RateLimiter(limits.recover_per_ip_per_hour, HOUR_MS, now);
	const recoverGlobal = new RateLimiter(10, DAY_MS, now);
	/** Failed sign-ins and recovery attempts in the last 10 minutes (alert `auth_fail` at 5). */
	const failures: number[] = [];

	const sessionCookie = (value: string): string =>
		`${ADMIN_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;
	const csrfOf = (idHash: string): string => csrfFor(secret, `admin:${idHash}`);
	const ui = adminUi({ app, owner, origin, secret, csrfOf });
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

	function signIn(reply: Reply): void {
		const value = owner.startSession();
		reply(200, { ok: true, csrf: csrfOf(sha256Hex(value)) }, { "set-cookie": sessionCookie(value) });
	}

	async function post(req: IncomingMessage, path: string, ip: string, json: Reply): Promise<void> {
		if (!sameOrigin(req)) return json(403, { error: "cross_origin" });
		const body = (await readPageJson(req)) ?? {};

		// ---- setup and recovery: no session; the token or code in the body is the proof ----
		if (SETUP_PATHS.has(path)) return setupStep({ owner, passkeys, signIn }, path, body, json);
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
			return signIn(json);
		}

		// ---- everything else needs a session and its CSRF token ----
		const session = owner.session(cookies(req)[ADMIN_COOKIE]);
		if (!session) return json(401, { error: "login_required" });
		if (!csrfOk(req, origin, secret, `admin:${session.idHash}`)) return json(403, { error: "csrf" });
		if (path === "/api/logout") {
			owner.endSession(session.idHash);
			return json(
				200,
				{ ok: true },
				{ "set-cookie": `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` },
			);
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
			// Approving is one of the actions that need fresh user verification (§3.4): this assertion is it.
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
			return openWindow({ app, provider, pairing, baseUrl: door.baseUrl }, body, json);
		}
		return json(404, { error: "not_found" });
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
					confirmDollars: view?.confirmDollars,
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
				post(req, path, ipPrefix(arrival.clientIp) ?? "unknown", json).catch(() => {
					if (!res.headersSent) json(500, { error: "server_error" });
				});
				return true;
			}
			// The admin UI's pages and actions (admin/ui.ts).
			const served = ui(req, res);
			if (served === undefined) return false;
			Promise.resolve(served).then(
				(status) => finish(status, "admin_ui"),
				() => {
					if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
					finish(500, "admin_ui");
				},
			);
			return true;
		},
	};
}
