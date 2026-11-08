// Q22 (m0-spike.md): does node:sqlite on Node 24 support what data-model.md needs?
// FTS5 with the store's tokenizer, WAL, every PRAGMA of data-model.md §1, and the
// purge mechanics (secure_delete, FTS optimize, checkpoint, VACUUM INTO).
//
//   node spikes/sqlite-check/src/q22.ts [--out <file.json>]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const CANARY = "PURGE-CANARY-7f3a91c2";

function scalar(db: DatabaseSync, sql: string): unknown {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

export function runQ22(dir: string): Check[] {
  const checks: Check[] = [];
  const check = (name: string, fn: () => [boolean, string]) => {
    try {
      const [ok, detail] = fn();
      checks.push({ name, ok, detail });
    } catch (e) {
      checks.push({ name, ok: false, detail: `threw: ${(e as Error).message}` });
    }
  };

  const file = join(dir, "store.db");
  const db = new DatabaseSync(file);
  check("sqlite version", () => [true, String(scalar(db, "SELECT sqlite_version()"))]);
  check("compile options include FTS5", () => {
    const opts = (db.prepare("PRAGMA compile_options").all() as { compile_options: string }[]).map((r) => r.compile_options);
    return [opts.includes("ENABLE_FTS5"), opts.filter((o) => /FTS|JSON|SECURE|THREADSAFE/.test(o)).join(", ")];
  });

  // data-model.md §1, aws mode
  check("journal_mode = WAL", () => {
    const v = String(scalar(db, "PRAGMA journal_mode = WAL"));
    return [v === "wal", v];
  });
  const pragmas: [string, string, number][] = [
    ["synchronous", "NORMAL", 1],
    ["busy_timeout", "5000", 5000],
    ["foreign_keys", "ON", 1],
    ["secure_delete", "ON", 1],
    ["wal_autocheckpoint", "0", 0],
  ];
  for (const [name, set, expect] of pragmas) {
    check(`${name} = ${set}`, () => {
      db.exec(`PRAGMA ${name} = ${set}`);
      const v = Number(scalar(db, `PRAGMA ${name}`));
      return [v === expect, `reads back ${v}`];
    });
  }

  // FTS5 exactly as data-model.md §2
  check("FTS5 table with porter unicode61 remove_diacritics 2", () => {
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      version_id UNINDEXED, content, excerpts, aliases,
      tokenize = 'porter unicode61 remove_diacritics 2')`);
    const ins = db.prepare("INSERT INTO memory_fts(version_id, content, excerpts, aliases) VALUES (?, ?, ?, ?)");
    ins.run("v1", "Prefers running in the morning before work", "", "");
    ins.run("v2", "Favourite café is near the station", "", "coffee shop");
    ins.run("v3", "Works as a nurse at a children's hospital", "", "");
    ins.run("v4", `Throwaway row holding ${CANARY} for the purge test`, "", "");
    return [true, "created, 4 rows"];
  });
  const match = (q: string) => (db.prepare("SELECT version_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank").all(q) as { version_id: string }[]).map((r) => r.version_id);
  check("porter stemming: 'run' finds 'running'", () => {
    const r = match("run");
    return [r.includes("v1"), JSON.stringify(r)];
  });
  check("remove_diacritics: 'cafe' finds 'café'", () => {
    const r = match("cafe");
    return [r.includes("v2"), JSON.stringify(r)];
  });
  check("column filter and bm25() column weights", () => {
    const rows = db
      .prepare("SELECT version_id, bm25(memory_fts, 0.0, 1.0, 0.5, 0.8) AS score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score")
      .all("aliases:coffee OR nurse") as { version_id: string; score: number }[];
    return [rows.length === 2 && rows.every((r) => r.score < 0), JSON.stringify(rows.map((r) => [r.version_id, Number(r.score.toFixed(3))]))];
  });

  // Foreign keys are enforced, not just accepted.
  check("foreign keys enforced", () => {
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))");
    try {
      db.prepare("INSERT INTO child VALUES ('c1', 'missing')").run();
      return [false, "insert with a dangling reference succeeded"];
    } catch (e) {
      return [/FOREIGN KEY/i.test((e as Error).message), (e as Error).message];
    }
  });

  check("JSON functions", () => {
    const v = scalar(db, `SELECT json_extract('{"a":{"b":[1,2,3]}}', '$.a.b[2]')`);
    return [Number(v) === 3, `json_extract -> ${String(v)}`];
  });

  // Purge mechanics (data-model.md §9, deployment-aws.md §4 ma-maint): delete, FTS optimize,
  // checkpoint, then the canary must be gone from the database file and the WAL.
  check("purge: secure_delete + optimize + checkpoint(TRUNCATE) leave no plaintext", () => {
    db.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)");
    db.prepare("INSERT INTO note (body) VALUES (?)").run(`${CANARY} ${"x".repeat(2000)}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = readFileSync(file).includes(CANARY);
    db.exec("BEGIN; DELETE FROM note; DELETE FROM memory_fts WHERE version_id = 'v4'; COMMIT;");
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const inDb = readFileSync(file).includes(CANARY);
    let inWal = false;
    try {
      inWal = readFileSync(`${file}-wal`).includes(CANARY);
    } catch {
      // no WAL file after TRUNCATE is fine
    }
    return [before && !inDb && !inWal, `present before purge: ${before}; after: db ${inDb}, wal ${inWal}`];
  });

  check("VACUUM INTO writes a compact copy (ma-maint)", () => {
    const copy = join(dir, "store.new.db");
    db.prepare("VACUUM INTO ?").run(copy);
    const copyDb = new DatabaseSync(copy, { readOnly: true });
    const n = Number(scalar(copyDb, "SELECT count(*) FROM memory_fts"));
    const integrity = String(scalar(copyDb, "PRAGMA integrity_check"));
    copyDb.close();
    return [n === 3 && integrity === "ok", `${n} FTS rows, integrity_check ${integrity}`];
  });

  check("integrity_check", () => {
    const v = String(scalar(db, "PRAGMA integrity_check"));
    return [v === "ok", v];
  });
  db.close();
  return checks;
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const dir = mkdtempSync(join(tmpdir(), "ma q22 "));
  try {
    const checks = runQ22(dir);
    const report = { question: "Q22", node: process.version, platform: `${process.platform}-${process.arch}`, ranAt: new Date().toISOString(), allPass: checks.every((c) => c.ok), checks };
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.allPass ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
