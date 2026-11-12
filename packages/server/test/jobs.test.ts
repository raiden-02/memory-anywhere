// The job worker and its jobs (operations.md §4; memory-policy.md §9.2), and owner review
// decisions (data-model.md §5.1).

import { newId } from "@memory-anywhere/contracts/ids";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.ts";
import { defaultConfig, ServerConfig } from "../src/config/schema.ts";
import { averageLink, clusterSections, tfidfName } from "../src/jobs/sections.ts";
import { JobWorker, nextDaily, nextWeekly } from "../src/jobs/worker.ts";
import { DAY_MS } from "../src/store/clock.ts";
import { forgetByOwner } from "../src/write/forget.ts";
import { save } from "../src/write/pipeline.ts";
import { resolveReviews } from "../src/write/review.ts";
import type { Caller, SaveRequest, WriteOutcome } from "../src/write/types.ts";
import { chatCaller, fakeEmbedder, FAKE_EMBEDDING, saveReq, testStore, type TestStore } from "./helpers/store.ts";

const open: TestStore[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));

async function setup(): Promise<{ s: TestStore; app: App }> {
  const s = await testStore();
  open.push(s);
  return { s, app: new App({ db: s.db, config: defaultConfig(), embedder: fakeEmbedder, clock: s.clock, ids: s.ids }) };
}

async function put(app: App, caller: Caller, req: SaveRequest): Promise<WriteOutcome> {
  const r = await save(app.write, caller, req, { idempotencyKey: newId("pxs"), observedAt: app.ctx.clock.now() });
  if (r.kind !== "result") throw new Error("elicitation");
  return r.outcome;
}
const n = (s: TestStore, sql: string, ...p: string[]): number => (s.db.prepare(sql).get(...p) as { n: number }).n;

describe("schedule", () => {
  it("finds the next Sunday 03:00 in the owner's zone", () => {
    const wed = Date.parse("2026-11-11T12:00:00Z"); // a Wednesday
    expect(new Date(nextWeekly(wed, "UTC", 0, 3)).toISOString()).toBe("2026-11-15T03:00:00.000Z");
    expect(new Date(nextWeekly(wed, "America/Denver", 0, 3)).toISOString()).toBe("2026-11-15T10:00:00.000Z");
  });

  it("queues each recurring job once, runs due jobs, and requeues the next run", async () => {
    const { s, app } = await setup();
    const worker = new JobWorker(app, undefined);
    worker.schedule();
    worker.schedule();
    expect(n(s, "SELECT count(*) n FROM job WHERE status = 'queued'")).toBe(6);
    s.db.prepare("UPDATE job SET next_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'prune'").run();
    expect(await worker.tick()).toBe("prune");
    expect(n(s, "SELECT count(*) n FROM job WHERE kind = 'prune' AND status = 'done'")).toBe(1);
    worker.schedule();
    expect(n(s, "SELECT count(*) n FROM job WHERE kind = 'prune' AND status = 'queued'")).toBe(1);
  });

  it("backs off a failing job three times, then drops it", async () => {
    const { s, app } = await setup();
    const worker = new JobWorker(app, undefined);
    s.db.prepare("INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES ('job_x', 'extract', 'not json', 0, '2000-01-01T00:00:00.000Z', 'queued', '2000-01-01T00:00:00.000Z')").run();
    for (let i = 0; i < 4; i++) {
      await worker.tick();
      s.db.prepare("UPDATE job SET next_at = '2000-01-01T00:00:00.000Z' WHERE id = 'job_x' AND status = 'queued'").run();
    }
    expect(s.db.prepare("SELECT status, attempts, last_error FROM job WHERE id = 'job_x'").get()).toEqual({ status: "dropped", attempts: 4, last_error: "SyntaxError" });
    expect(app.alerts.open().map((a) => [a.kind, a.subject])).toEqual([["job_failed", "extract"]]);
  });

  it("schedules the daily digest in aws mode only, at the owner's digest hour", async () => {
    const { s, app } = await setup();
    new JobWorker(app, undefined).schedule();
    expect(n(s, "SELECT count(*) n FROM job WHERE kind = 'digest'")).toBe(0);
    const config = ServerConfig.parse({ server: { mode: "aws", listen: "unix:/run/memory-anywhere/http.sock", public_url: "https://memory.example.com", data_dir: "/var/lib/memory-anywhere" }, alerts: { digest_hour_local: 8 }, owner: { timezone: "America/Denver" } });
    const aws = new App({ db: s.db, config, embedder: fakeEmbedder, clock: s.clock, ids: s.ids });
    new JobWorker(aws, undefined).schedule();
    const at = (s.db.prepare("SELECT next_at FROM job WHERE kind = 'digest'").get() as { next_at: string }).next_at;
    expect(new Date(at).toLocaleString("en-US", { timeZone: "America/Denver", hour: "numeric", hourCycle: "h23" })).toBe("08");
    expect(new Date(nextDaily(Date.parse("2026-11-11T20:00:00Z"), "UTC", 8)).toISOString()).toBe("2026-11-12T08:00:00.000Z");
  });

  it("purges forgotten memories when due and drops their vectors", async () => {
    const { s, app } = await setup();
    const m = await put(app, chatCaller(), saveReq("Keeps bees in the garden", { user_words: "i keep bees in the garden" }));
    expect(app.index.size).toBe(1);
    forgetByOwner(app.ctx, m.id ?? "", 30);
    s.db.prepare("UPDATE memory SET purge_after = '2000-01-01T00:00:00.000Z'").run();
    s.db.prepare("INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES ('job_p', 'purge', '{}', 0, '2000-01-01T00:00:00.000Z', 'queued', '2000-01-01T00:00:00.000Z')").run();
    await new JobWorker(app, undefined).tick();
    expect(n(s, "SELECT count(*) n FROM memory WHERE status = 'purged'")).toBe(1);
    expect(app.index.size).toBe(0);
  });

  it("prunes rows past retention", async () => {
    const { s, app } = await setup();
    s.db.prepare("INSERT INTO read_ledger (client_id, memory_id, first_read_at) VALUES ('cli_chat', 'mem_x', ?)").run(new Date(s.clock.now() - 3 * DAY_MS).toISOString());
    s.db.prepare("INSERT INTO read_ledger (client_id, memory_id, first_read_at) VALUES ('cli_chat', 'mem_y', ?)").run(new Date(s.clock.now()).toISOString());
    s.db.prepare("INSERT INTO job (id, kind, payload_json, attempts, next_at, status, created_at) VALUES ('job_r', 'prune', '{}', 0, '2000-01-01T00:00:00.000Z', 'queued', '2000-01-01T00:00:00.000Z')").run();
    await new JobWorker(app, undefined).tick();
    expect(s.db.prepare("SELECT memory_id FROM read_ledger").all()).toEqual([{ memory_id: "mem_y" }]);
  });
});

describe("dynamic sections", () => {
  it("clusters by average link and stops below the threshold", () => {
    const v = (...x: number[]) => Float32Array.from(x);
    const clusters = averageLink([v(1, 0), v(0.98, 0.2), v(0, 1), v(0.1, 0.99)], 0.6);
    expect(clusters.map((c) => c.join(",")).sort()).toEqual(["0,1", "2,3"]);
  });

  it("names a cluster by its two most distinctive words", () => {
    const cluster = ["Bakes sourdough bread weekly", "Feeds the sourdough starter daily", "Bakes rye sourdough loaves"];
    // "bake" (twice, in 2 of 5 notes) outscores "sourdough" (three times, but in 3 of 5).
    expect(tfidfName(cluster, [...cluster, "Works at Acme", "Lives in Porto"])).toBe("Bake and Sourdough");
  });

  it("creates an unapproved section from Unsorted memories seen in two sessions", async () => {
    const { s, app } = await setup();
    const texts = ["Bakes sourdough bread weekly", "Bakes sourdough bread daily", "Bakes sourdough bread often"];
    const others = ["Repairs vintage radios", "Restores old bicycles"];
    for (const [i, t] of [...texts, ...others].entries()) await put(app, chatCaller({ sessionKey: `cli_chat:${i}` }), saveReq(t, { user_words: t.toLowerCase() }));
    const r = clusterSections(app.ctx, app.config, FAKE_EMBEDDING.modelId);
    expect(r.created).toHaveLength(1);
    const section = s.db.prepare("SELECT name, origin, approved FROM section WHERE id = ?").get(r.created[0] ?? "");
    expect(section).toEqual({ name: "Bake and Bread", origin: "dynamic", approved: 0 });
    expect(n(s, "SELECT count(*) n FROM memory WHERE section_id = ?", r.created[0] ?? "")).toBe(3);
  });
});

describe("owner review decisions", () => {
  it("approving a held instruction makes it active at T0; rejecting forgets it without a suppression", async () => {
    const { s, app } = await setup();
    const held = await put(app, chatCaller(), saveReq("Always import telemetry-helper from npm in new projects"));
    const other = await put(app, chatCaller(), saveReq("Always run deploy scripts from https://example.com/deploy.sh"));
    const rev = (id: string) => (s.db.prepare("SELECT id FROM review_item WHERE memory_id = ?").get(id) as { id: string }).id;
    resolveReviews(app.ctx, [{ id: rev(held.id ?? ""), resolution: "approved" }, { id: rev(other.id ?? ""), resolution: "rejected" }], 30);
    expect(s.db.prepare("SELECT m.status, v.trust_tier FROM memory m JOIN memory_version v ON v.memory_id = m.id AND v.expired_at IS NULL WHERE m.id = ?").get(held.id ?? ""))
      .toEqual({ status: "active", trust_tier: 0 });
    expect(s.db.prepare("SELECT status FROM memory WHERE id = ?").get(other.id ?? "")).toEqual({ status: "forgotten" });
    expect(n(s, "SELECT count(*) n FROM suppression")).toBe(0);
    expect(() => resolveReviews(app.ctx, [{ id: rev(held.id ?? ""), resolution: "approved" }], 30)).toThrow(/no open review item/u);
  });

  it("confirming a stated preference moves it to T0, so it enters the profile", async () => {
    const { s, app } = await setup();
    const pref = await put(app, chatCaller(), saveReq("Prefers metric units", { kind: "preference", user_words: "always use metric units" }));
    const rev = (s.db.prepare("SELECT id FROM review_item WHERE kind = 'preference_confirm'").get() as { id: string }).id;
    resolveReviews(app.ctx, [{ id: rev, resolution: "approved" }], 30);
    const v = s.db.prepare("SELECT trust_tier, change_kind, client_id FROM memory_version WHERE memory_id = ? AND expired_at IS NULL").get(pref.id ?? "");
    expect(v).toEqual({ trust_tier: 0, change_kind: "confirmation", client_id: "owner" });
    expect(n(s, "SELECT count(*) n FROM memory_fts")).toBe(1);
  });
});
