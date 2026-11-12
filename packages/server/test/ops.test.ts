// M2 P1: the pieces aws mode adds around the core — alerts and the outbox, restored state, store
// compaction, and the front door that tells the mcp and admin surfaces apart behind Caddy.

import { randomBytes } from "node:crypto";
import { newId } from "@memory-anywhere/contracts/ids";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.ts";
import { NO_AUTH } from "../src/api/grant.ts";
import { defaultConfig, ServerConfig } from "../src/config/schema.ts";
import { awsDoor } from "../src/http/front.ts";
import { Logger } from "../src/http/log.ts";
import { createHttpServer } from "../src/http/server.ts";
import { Alerts } from "../src/ops/alerts.ts";
import { compactStore, zeroAndDelete } from "../src/ops/compact.ts";
import { FileOutbox, NO_OUTBOX } from "../src/ops/outbox.ts";
import { enterRestoredState, RestoreCheckFailed } from "../src/ops/restored.ts";
import { HOUR_MS, iso } from "../src/store/clock.ts";
import { openStore } from "../src/store/db.ts";
import { save } from "../src/write/pipeline.ts";
import { CHAT_CLIENT_ID, chatCaller, fakeEmbedder, saveReq, T0_MS, testStore, type TestStore } from "./helpers/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma ops "));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A store whose clock the test moves by hand. */
async function storeAt(): Promise<{ s: TestStore; clock: { t: number } }> {
  const s = await testStore({ memory: true });
  cleanup.push(() => s.close());
  const clock = { t: T0_MS };
  return { s: { ...s, clock: { now: () => clock.t } }, clock };
}

describe("alerts", () => {
  it("emails an immediate alert once, counts repeats, and emails again only after an hour", async () => {
    const { s, clock } = await storeAt();
    const outbox = tempDir();
    const alerts = new Alerts(s, new FileOutbox(outbox));
    const id = alerts.raise("auth_fail", { attempts: 5 });
    expect(JSON.parse(readFileSync(path.join(outbox, "alert-auth_fail.json"), "utf8"))).toMatchObject({ id: "auth_fail", count: 1 });
    rmSync(path.join(outbox, "alert-auth_fail.json"));

    clock.t += 10 * 60_000;
    expect(alerts.raise("auth_fail", { attempts: 6 })).toBe(id);
    expect(readdirSync(outbox)).toEqual([]); // within the hour: counted, not emailed
    clock.t += HOUR_MS;
    alerts.raise("auth_fail", { attempts: 7 });
    expect(JSON.parse(readFileSync(path.join(outbox, "alert-auth_fail.json"), "utf8"))).toMatchObject({ count: 3, details: { attempts: 7 } });
    expect(alerts.open()).toHaveLength(1);
  });

  it("keeps one open alert per subject, and a new one after acknowledgement", async () => {
    const { s } = await storeAt();
    const alerts = new Alerts(s, NO_OUTBOX);
    const a = alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
    alerts.raise("save_quota", { quota: 20 }, { subject: "cli_b" });
    expect(alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" })).toBe(a);
    alerts.acknowledge(a);
    expect(alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" })).not.toBe(a);
    expect(alerts.open().map((r) => [r.subject, r.count])).toEqual(expect.arrayContaining([["cli_a", 1], ["cli_b", 1]]));
  });

  it("a save over the hourly quota is refused and puts the client in the digest", async () => {
    const s = await testStore({ memory: true });
    cleanup.push(() => s.close());
    const app = new App({ db: s.db, config: defaultConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
    s.db.prepare("UPDATE client_policy SET quota_saves_per_hour = 1 WHERE client_id = ?").run(CHAT_CLIENT_ID);
    const put = (text: string) => save(app.write, chatCaller(), saveReq(text), { idempotencyKey: newId("pxs"), observedAt: s.clock.now() });
    await put("Prefers tea over coffee");
    await expect(put("Lives in Lisbon")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(app.alerts.open().map((a) => [a.kind, a.subject])).toEqual([["save_quota", CHAT_CLIENT_ID]]);
  });

  it("refuses details that could carry text, so no memory content reaches an email", async () => {
    const { s } = await storeAt();
    const alerts = new Alerts(s, NO_OUTBOX);
    expect(() => alerts.raise("job_failed", { note: "the user lives in Lisbon" })).toThrow(/not an id or code/u);
  });

  it("lists digest alerts once a day, only those raised or repeated since the last digest", async () => {
    const { s, clock } = await storeAt();
    const outbox = tempDir();
    const alerts = new Alerts(s, new FileOutbox(outbox));
    alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
    alerts.raise("pairing_race", {}); // immediate only: not in the digest
    expect(alerts.sendDigest()).toBe(1);
    const body = JSON.parse(readFileSync(path.join(outbox, `digest-${iso(clock.t).slice(0, 10)}.json`), "utf8")) as { alerts: { kind: string }[] };
    expect(body.alerts.map((a) => a.kind)).toEqual(["save_quota"]);
    clock.t += 60_000;
    expect(alerts.sendDigest()).toBe(0);
    clock.t += 60_000;
    alerts.raise("save_quota", { quota: 20 }, { subject: "cli_a" });
    expect(alerts.sendDigest()).toBe(1);
  });
});

describe("outbox", () => {
  it("writes a file atomically under a name the outbox script knows, and refuses any other", () => {
    const dir = tempDir();
    const outbox = new FileOutbox(dir);
    outbox.send("setup-token", "secret");
    expect(readdirSync(dir)).toEqual(["setup-token"]);
    expect(() => outbox.send("../escape", "x")).toThrow(/not an outbox file name/u);
    expect(() => outbox.send("alert-Bad Name.json", "x")).toThrow(/not an outbox file name/u);
  });
});

describe("restored state", () => {
  async function seeded(): Promise<{ s: TestStore; alerts: Alerts; flag: string; now: number }> {
    const { s, clock } = await storeAt();
    const at = iso(clock.t);
    s.db.prepare("INSERT INTO admin_session (id_hash, created_at, last_seen_at, uv_at, expires_at) VALUES ('h', ?, ?, ?, ?)").run(at, at, at, iso(clock.t + HOUR_MS));
    s.db.prepare("INSERT INTO pairing_window (id, vendor, method, opened_at, expires_at, pair_code) VALUES ('w', 'claude', 'static', ?, ?, 'ABCD2345')").run(at, iso(clock.t + 600_000));
    s.db.prepare("INSERT INTO grant_meta (grant_id, client_id, created_at) VALUES ('g1', 'cli_chat', ?)").run(at);
    s.db.prepare("INSERT INTO oidc_store (model, id, payload_json, grant_id) VALUES ('RefreshToken', 'r1', '{}', 'g1')").run();
    const flag = path.join(tempDir(), "restored");
    return { s, alerts: new Alerts(s, NO_OUTBOX), flag, now: clock.t };
  }

  it("does nothing without the flag", async () => {
    const { s, alerts, flag } = await seeded();
    expect(enterRestoredState(s, alerts, flag)).toBeUndefined();
  });

  it("after a lost instance: new secrets, sessions and windows revoked, grants kept, alert raised, flag removed", async () => {
    const { s, alerts, flag } = await seeded();
    writeFileSync(flag, '{"reason":"lost","to":""}\n');
    expect(enterRestoredState(s, alerts, flag)).toEqual({ reason: "lost", grantsRevoked: 0 });
    expect(s.db.prepare("SELECT count(*) n FROM admin_session WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT close_reason FROM pairing_window").get()).toEqual({ close_reason: "restored" });
    expect(s.db.prepare("SELECT count(*) n FROM meta WHERE key IN ('cookie_secret','mrtr_key')").get()).toEqual({ n: 2 });
    expect(s.db.prepare("SELECT revoked_at FROM grant_meta").get()).toEqual({ revoked_at: null });
    expect(alerts.open().map((a) => a.kind)).toEqual(["restored"]);
    expect(existsSync(flag)).toBe(false);
  });

  it("after a compromise, or to a point over an hour old, every OAuth grant ends too", async () => {
    for (const body of ['{"reason":"compromise","to":""}', JSON.stringify({ reason: "lost", to: iso(T0_MS - 2 * HOUR_MS) })]) {
      const { s, alerts, flag } = await seeded();
      writeFileSync(flag, body);
      expect(enterRestoredState(s, alerts, flag)?.grantsRevoked).toBe(1);
      expect(s.db.prepare("SELECT count(*) n FROM oidc_store").get()).toEqual({ n: 0 });
    }
  });

  it("refuses to start on a broken event chain or a malformed flag", async () => {
    const { s, alerts, flag } = await seeded();
    writeFileSync(flag, '{"reason":"oops"}');
    expect(() => enterRestoredState(s, alerts, flag)).toThrow(RestoreCheckFailed);
    writeFileSync(flag, '{"reason":"lost","to":""}');
    // An event whose hash does not match its contents, as a tampered or torn restore would leave.
    s.db.prepare("INSERT INTO event (id, at, actor, op, refs_json, prev_hash, hash) VALUES ('evt_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C', ?, 'system', 'test', '[]', ?, ?)")
      .run(iso(T0_MS), "0".repeat(64), "f".repeat(64));
    expect(() => enterRestoredState(s, alerts, flag)).toThrow(/event hash chain breaks/u);
    expect(existsSync(flag)).toBe(true);
  });
});

describe("maint --compact", () => {
  it("keeps every row, leaves no freed page of a deleted row in the file, and finishes an interrupted run", async () => {
    const s = await testStore();
    const file = s.file;
    const canary = `canary-${randomBytes(8).toString("hex")}`;
    s.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'kept'), ('gone', ?)").run(canary.repeat(200));
    s.db.prepare("DELETE FROM meta WHERE key = 'gone'").run();
    s.db.close();
    // A previous run that stopped after writing store.old.db.
    writeFileSync(file.replace(/\.db$/u, ".old.db"), canary);

    const r = compactStore(file);
    expect(r.bytesAfter).toBeGreaterThan(0);
    expect(readdirSync(path.dirname(file)).filter((f) => /old|new/u.test(f))).toEqual([]);
    expect(readFileSync(file).includes(canary)).toBe(false);
    const db = openStore(file, { mode: "aws" });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'keep'").get()).toEqual({ value: "kept" });
    db.close();
    rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5 });
  });

  it("zero-fills before deleting", () => {
    const file = path.join(tempDir(), "x.db");
    writeFileSync(file, "secret".repeat(1000));
    zeroAndDelete(file);
    expect(existsSync(file)).toBe(false);
  });
});

describe("aws front door", () => {
  const socketPath = (): string =>
    process.platform === "win32" ? `\\\\.\\pipe\\ma-test-${randomBytes(6).toString("hex")}` : path.join(tempDir(), "http.sock");

  async function awsServer(): Promise<{ sock: string; server: Server }> {
    const s = await testStore({ memory: true });
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "maint"));
    const config = ServerConfig.parse({ server: { mode: "aws", listen: "unix:/run/memory-anywhere/http.sock", public_url: "https://memory.example.com", data_dir: dataDir } });
    const app = new App({ db: s.db, config, embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
    const server = createHttpServer({ app, door: awsDoor(config.server.public_url), authenticate: NO_AUTH, logger: new Logger(() => undefined) });
    const sock = socketPath();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    cleanup.push(() => {
      server.close();
      s.close();
    });
    return { sock, server };
  }

  function get(sock: string, route: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: sock, path: route, method: "GET", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  const viaCaddy = (origin: "mcp" | "admin", host: string): Record<string, string> => ({ host, "x-ma-origin": origin, "x-forwarded-for": "203.0.113.7" });

  it("serves the mcp surface only with X-MA-Origin mcp on {host}", async () => {
    const { sock } = await awsServer();
    expect((await get(sock, "/v1/health", viaCaddy("mcp", "memory.example.com"))).status).toBe(200);
    expect((await get(sock, "/v1/health", { host: "memory.example.com", "x-forwarded-for": "203.0.113.7" })).status).toBe(403);
    expect((await get(sock, "/v1/health", viaCaddy("mcp", "admin.memory.example.com"))).status).toBe(403);
    expect((await get(sock, "/v1/health", { ...viaCaddy("mcp", "memory.example.com"), "x-forwarded-for": "not an ip" })).status).toBe(403);
  });

  it("never serves resource routes on the admin surface (S-WEB-05) and answers 401 with resource metadata", async () => {
    const { sock } = await awsServer();
    expect((await get(sock, "/v1/health", viaCaddy("admin", "admin.memory.example.com"))).status).toBe(404);
    expect((await get(sock, "/v1/health", { ...viaCaddy("admin", "memory.example.com") })).status).toBe(403);
    const r = await get(sock, "/v1/status", viaCaddy("mcp", "memory.example.com"));
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe('Bearer resource_metadata="https://memory.example.com/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"');
  });

  it("refuses a browser Origin on resource routes", async () => {
    const { sock } = await awsServer();
    expect((await get(sock, "/v1/status", { ...viaCaddy("mcp", "memory.example.com"), origin: "https://memory.example.com" })).status).toBe(403);
  });
});
