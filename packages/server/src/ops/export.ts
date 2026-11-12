// Exports (data-model.md §10–§11). The server builds the file and encrypts it to an age recipient
// registered in the admin UI; the private key never touches any host.
//
//   kind        tables                                                      encryption
//   full        the store's content (memories, versions, sources, events …)  age
//   full_auth   full + clients, grants, tokens, passkeys, recovery codes     age (moves the store to a new machine)
//   projects    approved projects only, as the career-os catalog             none (by design)
//
// Never exported: audit, read ledger, sessions, step-up requests, setup tokens, pairing windows,
// jobs, write requests, prompts, alerts, LLM spend and cache, the export log, embeddings.

import { Encrypter } from "age-encryption";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectsExportT } from "@memory-anywhere/contracts/schemas/export";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

const CONTENT_TABLES = [
  "section", "attribute", "entity", "entity_alias", "entity_activity", "repo", "memory", "memory_version", "source", "memory_source",
  "memory_contest", "observation", "observation_mention", "suppression", "foreign_suppression_key", "review_item", "import_batch", "import_item", "event",
] as const;
const AUTH_TABLES = ["oidc_store", "grant_meta", "client_policy", "passkey", "recovery_code", "export_recipient"] as const;
const CONTENT_META = [
  "schema_version", "store_id", "store_hmac_key", "embedding_model_id", "embedding_dim", "embedding_query_prefix", "embedding_doc_prefix",
  "embedding_files_sha256", "dup_threshold", "abstain_cosine", "sections_cluster_threshold", "policy_version",
] as const;
const AUTH_META = ["audit_hmac_key", "mrtr_key"] as const;

export type ExportKind = "full" | "full_auth" | "projects";

export interface StoreExport {
  readonly format: "memory-anywhere-store";
  readonly format_version: 1;
  readonly kind: "full" | "full_auth";
  readonly exported_at: string;
  readonly meta: Readonly<Record<string, string>>;
  /** Rows by table; BLOB values as {"$b64": "…"}. */
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

/** The full store (data-model.md §10), optionally with what signs apps and the owner in. */
export function storeExport(ctx: StoreContext, includeAuth: boolean): StoreExport {
  const { db } = ctx;
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of includeAuth ? [...CONTENT_TABLES, ...AUTH_TABLES] : CONTENT_TABLES) tables[t] = rowsOf(db, t);
  const keys: readonly string[] = includeAuth ? [...CONTENT_META, ...AUTH_META] : CONTENT_META;
  const meta = Object.fromEntries((prepared(db, `SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(",")}) ORDER BY key`).all(...keys) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return { format: "memory-anywhere-store", format_version: 1, kind: includeAuth ? "full_auth" : "full", exported_at: iso(ctx.clock.now()), meta, tables };
}

function rowsOf(db: DatabaseSync, table: string): Record<string, unknown>[] {
  return (db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : v])),
  );
}

/** Encrypts bytes to one age recipient (`age1…`); the result is the binary age format. */
export async function encryptTo(recipient: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(plaintext);
}

interface SlotRow { readonly memory_id: string; readonly attribute: string; readonly status: string; readonly content: string; readonly valid_from: string | null; readonly recorded_at: string }

/**
 * The project catalog (data-model.md §11): approved projects only, never a sensitive memory.
 * A `one` slot with several values reports the newest and lists every value in contested_fields.
 */
export function projectsExport(ctx: StoreContext): ProjectsExportT {
  const { db } = ctx;
  const projects = prepared(db, "SELECT id, canonical_name FROM entity WHERE type = 'project' AND status = 'active' AND approved = 1 ORDER BY canonical_name").all() as { id: string; canonical_name: string }[];
  const aliases = prepared(db, "SELECT alias_norm FROM entity_alias WHERE entity_id = ? AND origin <> 'canonical' AND approved = 1 ORDER BY alias_norm");
  const slots = prepared(db, `SELECT m.id memory_id, a.name attribute, m.status, v.content, v.valid_from, v.recorded_at
      FROM memory m JOIN attribute a ON a.id = m.attribute_id
      JOIN memory_version v ON v.id = (SELECT max(id) FROM memory_version WHERE memory_id = m.id)
      WHERE m.entity_id = ? AND m.status IN ('active','contested') AND m.sensitivity_category IS NULL AND v.content IS NOT NULL
      ORDER BY v.recorded_at, m.id`);
  const activity = prepared(db, "SELECT max(last_activity_at) at FROM entity_activity WHERE entity_id = ?");
  return {
    format: "memory-anywhere-projects",
    format_version: 1,
    exported_at: iso(ctx.clock.now()),
    projects: projects.map((p) => {
      const rows = slots.all(p.id) as unknown as SlotRow[];
      const of = (attr: string): SlotRow[] => rows.filter((r) => r.attribute === `project.${attr}`);
      const contested: Record<string, { value: string; memory_id: string }[]> = {};
      const one = (attr: string): string | null => {
        const values = of(attr);
        if (values.length > 1) contested[attr] = values.map((v) => ({ value: v.content, memory_id: v.memory_id }));
        return values.at(-1)?.content ?? null;
      };
      const dated = (attr: string) => of(attr).map((r) => ({ id: r.memory_id, content: r.content, valid_from: r.valid_from }));
      // Status memories are text ("Status: active", "The project is paused"); the catalog takes the status word in it.
      const status = /\b(idea|active|paused|shipped|archived)\b/iu.exec(one("status") ?? "")?.[1]?.toLowerCase() as ProjectsExportT["projects"][number]["status"] | undefined;
      return {
        entity_id: p.id,
        name: p.canonical_name,
        aliases: (aliases.all(p.id) as { alias_norm: string }[]).map((a) => a.alias_norm),
        status: status ?? null,
        goal: one("goal"),
        contested_fields: contested,
        role: one("role"),
        repo: one("repo"),
        stack: of("stack").map((r) => r.content),
        decisions: dated("decision"),
        constraints: dated("constraint").map(({ id, content }) => ({ id, content })),
        outcomes: dated("outcome"),
        portfolio_relevance: of("portfolio_relevance").map((r) => r.content),
        last_activity_at: (activity.get(p.id) as { at: string | null } | undefined)?.at ?? null,
      };
    }),
  };
}

/** Records an export in export_log (who, what, to which key, under which approval). */
export function logExport(ctx: StoreContext, o: { kind: ExportKind; fingerprint: string | undefined; stepupRequestId: string | undefined; clientId: string }): void {
  prepared(ctx.db, "INSERT INTO export_log (id, at, kind, recipient_fingerprint, stepup_request_id, client_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ctx.ids.newId("adm", ctx.clock.now()), iso(ctx.clock.now()), o.kind, o.fingerprint ?? null, o.stepupRequestId ?? null, o.clientId);
}
