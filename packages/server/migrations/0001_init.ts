// Migration 0001, data step: insert the default sections and the attribute registry
// (data-model.md §4) from packages/server/seed/. Seed rows carry one fixed timestamp, so two stores
// that receive the same writes have the same content hash (data-model.md §12).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SEED_AT } from "../src/store/seed.ts";

interface SeedSection {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  sort_order: number;
}

interface SeedAttribute {
  id: string;
  name: string;
  entity_type: string;
  cardinality: string;
  section_id: string;
  taste_class: boolean;
  profile_key: boolean;
  restricted: boolean;
  aliases: string[];
  sort_order: number;
  description: string;
}

const SEED_DIR = join(import.meta.dirname, "../seed");
const read = <T>(file: string): T => JSON.parse(readFileSync(join(SEED_DIR, file), "utf8")) as T;

export function up(db: DatabaseSync): void {
  const section = db.prepare(
    `INSERT INTO section (id, name, description, aliases_json, origin, approved, status, sort_order, created_at, created_by)
     VALUES (?, ?, ?, ?, 'default', 1, 'active', ?, ?, 'seed')`,
  );
  for (const s of read<SeedSection[]>("sections.json")) {
    section.run(s.id, s.name, s.description, JSON.stringify(s.aliases), s.sort_order, SEED_AT);
  }
  const attribute = db.prepare(
    `INSERT INTO attribute (id, name, entity_type, cardinality, section_id, taste_class, profile_key, restricted, aliases_json, sort_order, origin, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
  );
  for (const a of read<SeedAttribute[]>("attributes.json")) {
    attribute.run(
      a.id, a.name, a.entity_type, a.cardinality, a.section_id,
      Number(a.taste_class), Number(a.profile_key), Number(a.restricted),
      JSON.stringify(a.aliases), a.sort_order, a.description,
    );
  }
}
