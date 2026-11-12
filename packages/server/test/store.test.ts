import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDump, contentHash, storeHash } from "../src/store/dump.ts";
import { openStore, transaction } from "../src/store/db.ts";
import { appendEvent, verifyEventChain } from "../src/store/events.ts";
import { LOCAL_CLIENT_ID, SELF_ENTITY_ID } from "../src/store/init.ts";
import { assertSchemaCurrent, latestVersion, migrate, MIGRATIONS_DIR, schemaVersion } from "../src/store/migrate.ts";
import { testStore, type TestStore } from "./helpers/store.ts";

const ROOT = path.join(import.meta.dirname, "../../..");
const open: TestStore[] = [];
const store = async (seed = 1) => {
  const s = await testStore({ seed });
  open.push(s);
  return s;
};
afterEach(() => open.splice(0).forEach((s) => s.close()));

const count = (s: TestStore, sql: string) => (s.db.prepare(sql).get() as { n: number }).n;

describe("migration 0001", () => {
  it("is the spec's DDL and views, verbatim", () => {
    const spec = readFileSync(path.join(ROOT, "docs/spec/data-model.md"), "utf8");
    const blocks = [...spec.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
    const migration = readFileSync(path.join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
    const ddl = blocks.find((b) => b?.includes("CREATE TABLE meta"));
    const views = blocks.find((b) => b?.includes("CREATE VIEW current_version"));
    expect(migration).toContain(ddl);
    expect(migration).toContain(views);
  });

  it("creates the schema, the seeds and the init rows", async () => {
    const s = await store();
    expect(schemaVersion(s.db)).toBe(latestVersion());
    expect(count(s, "SELECT count(*) n FROM section")).toBe(9);
    expect(count(s, "SELECT count(*) n FROM attribute")).toBe(44);
    expect(count(s, "SELECT count(*) n FROM attribute WHERE taste_class = 1")).toBe(7);
    expect(count(s, "SELECT count(*) n FROM attribute WHERE restricted = 1")).toBe(2);
    expect(s.db.prepare("SELECT id, type FROM entity").all()).toEqual([{ id: SELF_ENTITY_ID, type: "self" }]);
    expect(s.db.prepare("SELECT client_id, class, quota_saves_per_hour, read_budget_24h FROM client_policy WHERE client_id = 'cli_local'").all()).toEqual([
      { client_id: LOCAL_CLIENT_ID, class: "coding", quota_saves_per_hour: 40, read_budget_24h: 200 },
    ]);
    const meta = Object.fromEntries((s.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    for (const k of ["schema_version", "store_id", "store_hmac_key", "audit_hmac_key", "audit_hmac_key_rotated_at", "embedding_model_id",
      "embedding_dim", "embedding_query_prefix", "embedding_doc_prefix", "embedding_files_sha256", "dup_threshold", "abstain_cosine",
      "sections_cluster_threshold", "policy_version", "event_chain_head", "mrtr_key", "cookie_secret"]) {
      expect(meta[k], k).toBeTruthy();
    }
    expect(Buffer.from(meta["store_hmac_key"] ?? "", "base64")).toHaveLength(32);
  });

  it("applies the data-model.md §1 PRAGMAs", async () => {
    const s = await store();
    const pragma = (p: string) => Object.values(s.db.prepare(`PRAGMA ${p}`).get() ?? {})[0];
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(1); // NORMAL
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("secure_delete")).toBe(1);
  });

  it.skipIf(process.platform === "win32")("creates the store file with mode 0660 before SQLite opens it", async () => {
    const s = await store();
    expect(statSync(s.file).mode & 0o777).toBe(0o660 & ~process.umask());
  });
});

describe("migrator", () => {
  it("refuses a schema it does not expect", async () => {
    const s = await store();
    s.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(latestVersion() + 1));
    expect(() => assertSchemaCurrent(s.db)).toThrow(/newer than this server/);
  });

  it("upgrades an existing store and keeps a pre-migrate copy", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ma migrations "));
    try {
      // A migrations folder holding the real 0001 (its data step re-exported, so its own imports
      // still resolve) and a new 0002.
      copyFileSync(path.join(MIGRATIONS_DIR, "0001_init.sql"), path.join(dir, "0001_init.sql"));
      const realStep = pathToFileURL(path.join(MIGRATIONS_DIR, "0001_init.ts")).href;
      writeFileSync(path.join(dir, "0001_init.ts"), `export { up } from ${JSON.stringify(realStep)};\n`);
      const file = path.join(dir, "store.db");
      const db = openStore(file, { mode: "local" });
      try {
        await migrate(db, file, dir);
        writeFileSync(path.join(dir, "0002_test.sql"), "CREATE TABLE test_added (id INTEGER PRIMARY KEY);\n");
        const r = await migrate(db, file, dir);
        expect(r).toMatchObject({ from: 1, to: 2 });
        expect(r.backup && existsSync(r.backup)).toBe(true);
        expect(schemaVersion(db)).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("transactions and events", () => {
  it("rolls back everything when the body throws", async () => {
    const s = await store();
    expect(() =>
      transaction(s.db, () => {
        s.db.prepare("INSERT INTO alert (id, kind, at, details_json) VALUES ('alr_x', 'test', 'now', '{}')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count(s, "SELECT count(*) n FROM alert")).toBe(0);
  });

  it("chains events by hash and detects an edited row", async () => {
    const s = await store();
    transaction(s.db, () => {
      appendEvent(s, { actor: "system", op: "test.one", refs: { id: "a" } });
      appendEvent(s, { actor: "system", op: "test.two", refs: { id: "b" }, undo: { status: "active" } });
    });
    expect(verifyEventChain(s.db)).toBeUndefined();
    s.db.prepare("UPDATE event SET refs_json = '{\"id\":\"c\"}' WHERE op = 'test.one'").run();
    expect(verifyEventChain(s.db)).toMatch(/^evt_/);
  });
});

describe("canonical dump and hashes", () => {
  it("leaves out volatile and secret rows", async () => {
    const s = await store();
    const dump = canonicalDump(s.db).join("\n");
    expect(dump).not.toContain('"table":"write_request"');
    expect(dump).not.toContain("mrtr_key");
    expect(dump).not.toContain("cookie_secret");
    expect(dump).not.toContain("audit_hmac_key");
    expect(dump).toContain("store_hmac_key");
  });

  it("gives equal content hashes for two stores with the same writes and seeded ids", async () => {
    const a = await store(7);
    const b = await store(7);
    expect(contentHash(a.db)).toBe(contentHash(b.db));
    expect(storeHash(a.db)).not.toBe(storeHash(b.db)); // store_id and keys differ per store
  });
});

describe("migration fixtures", () => {
  it("migrates the committed v1 fixture to the current schema, keeping its data", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ma fixture "));
    const file = path.join(dir, "store.db");
    copyFileSync(path.join(import.meta.dirname, "fixtures/store-v1.db"), file);
    const db = openStore(file, { mode: "local" });
    try {
      const r = await migrate(db, file);
      expect(r.from).toBe(1);
      assertSchemaCurrent(db);
      expect((db.prepare("SELECT count(*) n FROM attribute").get() as { n: number }).n).toBe(44);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
