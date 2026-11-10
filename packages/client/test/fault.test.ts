// Fault injection (operations.md §9): a process killed while draining the spool. Whatever moment
// it dies at, a later drain delivers every entry, and the store holds each exactly once (the
// idempotency key makes a re-sent entry a no-op). MA_FAULT_RUNS sets the number of kills (the
// nightly workflow runs 100).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { drain, spoolStats, spoolWrite } from "../src/spool.ts";
import { localServer, tempHome, TOKEN } from "./helpers.ts";

const RUNS = Number(process.env["MA_FAULT_RUNS"] ?? 3);
const ENTRIES = 250;
const REPO = "rk_0123456789abcdef0123456789abcdef";

it(`delivers every spooled entry exactly once after a drain is killed (${RUNS} kills)`, async () => {
  for (let run = 0; run < RUNS; run++) {
    const h = tempHome();
    const server = await localServer();
    try {
      for (let n = 0; n < ENTRIES; n++) {
        spoolWrite(h.paths, {
          idempotency_key: `spl_01JC9Z3N4V8Q2W5X7Y9Z${String(n).padStart(6, "0")}`, spooled_at: new Date().toISOString(), op: "prompt", tool: "claude-code",
          repo_key: REPO, session_id: "fault", payload: { prompt: `remember fault test entry ${n}` },
        });
      }
      const tokenFile = path.join(h.dir, "token");
      writeFileSync(tokenFile, TOKEN);
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "fault", "drain-child.ts")], {
        env: { ...process.env, MA_HOME: path.join(h.dir, "data"), MA_STORE_URL: server.url, MA_TOKEN_FILE: tokenFile },
        stdio: ["ignore", "pipe", "ignore"],
      });
      // Taken now: a child that finishes before the kill must not be waited for forever.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      // Kill somewhere between before the first batch and after the last.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 120)));
      child.kill("SIGKILL");
      await exited;

      // The lock of the killed drainer is stale only after 60 s; a later drain waits it out.
      const later = Date.now() + 61_000;
      const r = await drain(h.paths, server.client, later + 30_000, () => later);
      expect(r.busy, `run ${run}`).toBe(false);
      expect(spoolStats(h.paths).count, `run ${run}`).toBe(0);
      const stored = server.store.db.prepare("SELECT count(*) AS n, count(DISTINCT idempotency_key) AS k FROM write_request").get() as { n: number; k: number };
      expect(stored, `run ${run}`).toEqual({ n: ENTRIES, k: ENTRIES });
      expect(server.store.db.prepare("SELECT count(*) AS n FROM session_prompt").get(), `run ${run}`).toEqual({ n: ENTRIES });
    } finally {
      await server.stop();
      server.store.close();
      h.cleanup();
    }
  }
}, 120_000 + RUNS * 5_000);
