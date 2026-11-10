import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { idPattern, isId, newId } from "../src/ids.ts";
import { resolvePaths, resolveToolPaths } from "../src/paths.ts";
import { REASON_CODES, REASON_MESSAGES } from "../src/reasons.ts";
import { ensurePrivateDir, writeFileAtomic } from "../src/secure-fs.ts";
import { SpoolRecord, spoolRecordToEntry } from "../src/spool.ts";
import { Entry } from "../src/schemas/v1.ts";

describe("reason codes", () => {
  it("has the 31 codes of write-path.md §5.2, each with a short one-line message", () => {
    const spec = readFileSync(path.join(import.meta.dirname, "../../../docs/spec/write-path.md"), "utf8");
    const listed = (spec.match(/### 5\.2 Reason codes\n\n(.*)\n/)?.[1] ?? "").match(/`([a-z_]+)`/g)?.map((s) => s.slice(1, -1));
    expect(REASON_CODES).toEqual(listed);
    expect(REASON_CODES).toHaveLength(31);
    for (const m of Object.values(REASON_MESSAGES)) {
      expect(m.length).toBeLessThan(300);
      expect(m).not.toMatch(/\n/);
    }
  });
});

describe("ids", () => {
  it("creates prefixed ULIDs that sort in creation order within one millisecond", () => {
    const a = newId("spl", 1_700_000_000_000);
    const b = newId("spl", 1_700_000_000_000);
    expect(a).toMatch(idPattern("spl"));
    expect(a < b).toBe(true);
    expect(isId("mem", "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C")).toBe(true);
    expect(isId("mem", "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2I")).toBe(false); // I is not Crockford
  });
});

describe("paths", () => {
  it("places M1 files in {data} on Windows, spaces intact", () => {
    const p = resolvePaths({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ann Lee\\AppData\\Local" }, home: "C:\\Users\\Ann Lee" });
    const data = "C:\\Users\\Ann Lee\\AppData\\Local\\memory-anywhere";
    expect(p).toMatchObject({
      localTokenFile: `${data}\\local.token`,
      spoolDir: `${data}\\spool`,
      spoolDeadDir: `${data}\\spool\\dead`,
      spoolDrainLock: `${data}\\spool\\.drain.lock`,
      cacheDir: `${data}\\cache`,
      hooksLog: `${data}\\logs\\hooks.log`,
      modelsDir: `${data}\\models`,
    });
  });

  it("puts tool files under home, keeps the Cursor plugin under ~/.cursor, and honours CODEX_HOME", () => {
    const t = resolveToolPaths({ platform: "win32", env: {}, home: "C:\\Users\\Ann Lee" });
    expect(t.claudeSettingsFile).toBe("C:\\Users\\Ann Lee\\.claude\\settings.json");
    expect(t.cursorPluginDir).toBe("C:\\Users\\Ann Lee\\.cursor\\plugins\\local\\memory-anywhere");
    expect(t.cursorPluginDir).not.toMatch(/AppData/i);
    expect(resolveToolPaths({ platform: "linux", env: { CODEX_HOME: "/x/codex home" }, home: "/home/ann" }).codexConfigFile).toBe(
      "/x/codex home/config.toml",
    );
  });
});

describe("spool records", () => {
  it("parse version 1 and replay as a /v1/writes entry with observed_at = spooled_at", () => {
    const record = SpoolRecord.parse({
      format_version: 1,
      idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C",
      spooled_at: "2026-11-07T17:38:00.000Z",
      op: "prompt",
      tool: "claude-code",
      repo_key: "rk_0123456789abcdef0123456789abcdef",
      session_id: "s1",
      payload: { prompt: "remember that I use pnpm" },
    });
    const entry = Entry.parse(spoolRecordToEntry(record));
    expect(entry.observed_at).toBe("2026-11-07T17:38:00.000Z");
  });

  it("reject a forget, which is never spooled", () => {
    expect(() =>
      SpoolRecord.parse({ format_version: 1, idempotency_key: "spl_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", spooled_at: "2026-11-07T17:38:00.000Z", op: "forget", tool: "codex", repo_key: "none", session_id: "s", payload: {} }),
    ).toThrow();
  });
});

describe("secure files", () => {
  it("writes atomically into a private directory with a space in its path", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ma secure "));
    try {
      const dir = path.join(root, "spool dir");
      ensurePrivateDir(dir);
      const file = path.join(dir, "a.json");
      writeFileAtomic(file, '{"a":1}', { private: true });
      writeFileAtomic(file, '{"a":2}', { private: true });
      expect(readFileSync(file, "utf8")).toBe('{"a":2}');
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
