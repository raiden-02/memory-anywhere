// The admin UI in local mode (auth-and-security.md §8.1): at /admin on 127.0.0.1, opened by
// `mema ui` through a one-time link; no passkeys, because the local token is the owner credential.

import { newId } from "@memory-anywhere/contracts/ids";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { App, SERVER_VERSION } from "../src/app.ts";
import { localAdmin } from "../src/admin/local-ui.ts";
import { localTokenAuth } from "../src/api/grant.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { localDoor } from "../src/http/front.ts";
import { Logger } from "../src/http/log.ts";
import { createHttpServer } from "../src/http/server.ts";
import { save } from "../src/write/pipeline.ts";
import { fakeEmbedder, ownerCaller, saveReq, testStore, type TestStore } from "./helpers/store.ts";

const TOKEN = "local-ui-test-token-0123456789abcdefghijklmnopqrst";
let s: TestStore;
let app: App;
let server: Server;
let base = "";

beforeAll(async () => {
  s = await testStore({ memory: true });
  app = new App({ db: s.db, config: defaultConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
  const port = await new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const door = localDoor(port);
  server = createHttpServer({ app, door, authenticate: localTokenAuth(TOKEN), mounts: { mcp: localAdmin({ app, door, localToken: TOKEN }) }, logger: new Logger(() => undefined) });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  base = door.baseUrl;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  s.close();
});

async function signIn(): Promise<{ cookie: string; csrf: string }> {
  const link = (await (await fetch(`${base}/admin/link`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { url: string };
  const login = await fetch(link.url, { redirect: "manual" });
  expect(login.status).toBe(303);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const html = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
  return { cookie, csrf: /data-csrf="([^"]*)"/u.exec(html)?.[1] ?? "" };
}

test("mema ui's link needs the local token and works once", async () => {
  expect((await fetch(`${base}/admin/link`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  const link = (await (await fetch(`${base}/admin/link`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { url: string };
  expect(link.url).toMatch(/\/admin\/login\?code=/u);
  expect((await fetch(link.url, { redirect: "manual" })).status).toBe(303);
  expect((await fetch(link.url, { redirect: "manual" })).status).toBe(400);
});

test("the pages need the session; links and assets stay under /admin", async () => {
  expect(await (await fetch(`${base}/admin/`)).text()).toContain("Run mema ui");
  const { cookie } = await signIn();
  const html = await (await fetch(`${base}/admin/memories`, { headers: { cookie } })).text();
  expect(html).toContain('href="/admin/reviews"');
  expect(html).toContain('src="/admin/assets/app.js"');
  expect(html).not.toContain("Connect an app");
  expect((await fetch(`${base}/admin/assets/app.css`)).status).toBe(200);
  // The resource routes are unchanged.
  expect((await fetch(`${base}/v1/health`)).status).toBe(200);
});

test("actions need no passkey in local mode, but still need the CSRF token", async () => {
  const r = await save(app.write, ownerCaller(), saveReq("Prefers trains to planes"), { idempotencyKey: newId("adm"), observedAt: s.clock.now() });
  const id = r.kind === "result" ? (r.outcome.id ?? "") : "";
  const { cookie, csrf } = await signIn();
  const act = (headers: Record<string, string>) =>
    fetch(`${base}/admin/api/act/memory.purge`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: base, "ma-client-version": SERVER_VERSION, ...headers }, body: JSON.stringify({ input: { id } }) });
  expect((await act({ "x-ma-csrf": "forged" })).status).toBe(403);
  expect((await act({ "x-ma-csrf": csrf })).status).toBe(200);
  expect((s.db.prepare("SELECT status FROM memory WHERE id = ?").get(id) as { status: string }).status).toBe("purged");
});
