import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkpoint, compact, dumpHash, init, purge, write } from "../src/probe.ts";

const dir = mkdtempSync(join(tmpdir(), "ma probe "));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CANARY = "Q21-CANARY-test";

describe("litestream probe (local, no Litestream)", () => {
  const db = join(dir, "store.db");

  it("creates a WAL store and writes rows", () => {
    init(db);
    write(db, 50, CANARY);
    // Without Litestream holding a connection, SQLite checkpoints and removes the WAL on close,
    // so check the persistent journal mode rather than the -wal file.
    const header = readFileSync(db).subarray(18, 20);
    expect([...header]).toEqual([2, 2]); // file format read/write version 2 = WAL
  });

  it("purges the canary row and its FTS entry", () => {
    expect(purge(db, CANARY)).toBe(1);
  });

  it("checkpoints with TRUNCATE when nothing else holds a read transaction", () => {
    expect(checkpoint(db).busy).toBe(0);
  });

  it("compacts: same logical content, no canary bytes anywhere, no WAL left", () => {
    const before = dumpHash(db);
    const r = compact(db);
    expect(r.after).toBeGreaterThan(0);
    expect(dumpHash(db)).toBe(before);
    expect(readFileSync(db).includes(CANARY)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(join(dir, "store.new.db"))).toBe(false);
  });

  it("gives a different dump hash after one more row", () => {
    const h = dumpHash(db);
    write(db, 1);
    expect(dumpHash(db)).not.toBe(h);
  });
});
