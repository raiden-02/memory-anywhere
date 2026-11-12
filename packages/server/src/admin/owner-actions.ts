// What the owner can do in the admin UI (auth-and-security.md §8.1). Every action is a T0 write
// through the store's own functions, recorded in the event chain. Actions marked `uv` need a
// user-verified passkey assertion within the last 5 minutes (§3.4); the UI asks for one first.
//
//   memories      edit (new T0 version), pin, forget, undo, purge (uv), resolve a contested pair
//   review queue  approve (uv for instruction and sensitive), reject
//   observations  promote, forget
//   sections      approve, rename, undo, merge; attributes: add
//   repos         enable, disable, capture on/off
//   clients       policy (uv), revoke (uv), revert by time window (uv)
//   export keys   add (uv), revoke (uv)
//   alerts        acknowledge; owner reset: cancel

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { App } from "../app.ts";
import { revokeClientGrants } from "../auth/clients.ts";
import { RESTRICTED_SECTIONS } from "../auth/vendors.ts";
import { iso } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { LOCAL_CLIENT_ID } from "../store/init.ts";
import { forgetByOwner, purgeMemory, undoForget } from "../write/forget.ts";
import { save } from "../write/pipeline.ts";
import { resolveReviews } from "../write/review.ts";
import { setMemoryStatus } from "../write/rows.ts";
import { WriteError, type Caller } from "../write/types.ts";
import { repoDisable, repoEnable } from "./commands.ts";

const OWNER: Caller = {
  clientId: LOCAL_CLIENT_ID, clientClass: "coding", channel: "admin", tier: 0, sessionKey: "admin", repoKey: undefined, tool: undefined,
  floored: false, canElicit: false, elicitationAnswer: undefined,
};

const Id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u"));
const MemId = Id("mem");
/** Seeded sections and clients have readable ids (`sec_profile`, `cli_local`); the rest are ULIDs. */
const SectionId = z.string().regex(/^sec_[A-Za-z0-9_]{1,40}$/u);
const ClientId = z.string().regex(/^cli_[A-Za-z0-9_]{1,40}$/u);

export class ActionError extends Error {}

interface Action<S extends z.ZodType> {
  readonly input: S;
  /** Needs a fresh user-verified assertion (§3.4). */
  readonly uv: boolean | ((input: z.output<S>, app: App) => boolean);
  run(app: App, input: z.output<S>): Promise<unknown> | unknown;
}

const action = <S extends z.ZodType>(a: Action<S>): Action<S> => a;

function memoryStatus(app: App, id: string): string {
  const m = prepared(app.ctx.db, "SELECT status FROM memory WHERE id = ?").get(id) as { status: string } | undefined;
  if (!m) throw new ActionError("no such memory");
  return m.status;
}

/** The kind, entity and attribute a memory or observation is about, for an owner save on the same slot. */
function slotOf(app: App, table: "memory" | "observation", id: string): { kind: "fact" | "preference" | "instruction" | "event"; entity: string; attribute?: string } | undefined {
  const r = prepared(app.ctx.db, `SELECT t.kind, e.canonical_name entity, a.name attribute FROM ${table} t
      LEFT JOIN entity e ON e.id = t.entity_id LEFT JOIN attribute a ON a.id = t.attribute_id WHERE t.id = ?`).get(id) as
    | { kind: "fact" | "preference" | "instruction" | "event"; entity: string | null; attribute: string | null }
    | undefined;
  if (!r) return undefined;
  return { kind: r.kind, entity: r.entity ?? "self", ...(r.attribute ? { attribute: r.attribute } : {}) };
}

/** In aws mode a purge leaves the flag that makes tonight's maintenance compact the store (deployment-aws.md §4). */
function markPurgePending(app: App): void {
  if (app.config.server.mode !== "aws" || !app.config.server.data_dir) return;
  const maint = path.join(app.config.server.data_dir, "maint");
  mkdirSync(maint, { recursive: true });
  writeFileSync(path.join(maint, "purge-pending"), `${iso(app.ctx.clock.now())}\n`);
}

export const ACTIONS = {
  "memory.edit": action({
    input: z.strictObject({ id: MemId, content: z.string().min(1).max(400), change: z.enum(["update", "correction"]) }),
    uv: false,
    async run(app, i) {
      const slot = slotOf(app, "memory", i.id);
      if (!slot) throw new ActionError("no such memory");
      const r = await save(app.write, OWNER, { content: i.content, ...slot, why_durable: "edited by the owner", explicit_request: true, scope: "global", supersedes: i.id, change: i.change },
        { idempotencyKey: app.ctx.ids.newId("adm", app.ctx.clock.now()), observedAt: app.ctx.clock.now() });
      return r.kind === "result" ? r.outcome : undefined;
    },
  }),
  "memory.pin": action({
    input: z.strictObject({ id: MemId, pinned: z.boolean() }),
    uv: false,
    run(app, i) {
      memoryStatus(app, i.id);
      transaction(app.ctx.db, () => {
        prepared(app.ctx.db, "UPDATE memory SET pinned = ?, updated_at = ? WHERE id = ?").run(i.pinned ? 1 : 0, iso(app.ctx.clock.now()), i.id);
        appendEvent(app.ctx, { actor: "owner", op: i.pinned ? "memory.pin" : "memory.unpin", refs: { memory_id: i.id } });
      });
      app.committed([i.id]);
    },
  }),
  "memory.forget": action({
    input: z.strictObject({ id: MemId }),
    uv: false,
    run(app, i) {
      memoryStatus(app, i.id);
      forgetByOwner(app.ctx, i.id, app.config.retention.forgotten_purge_days);
      app.committed([i.id]);
    },
  }),
  "memory.undo": action({
    input: z.strictObject({ id: MemId }),
    uv: false,
    run(app, i) {
      if (!undoForget(app.ctx, i.id)) throw new ActionError("this memory cannot be restored");
      app.committed([i.id]);
    },
  }),
  "memory.purge": action({
    input: z.strictObject({ id: MemId }),
    uv: true,
    run(app, i) {
      if (memoryStatus(app, i.id) === "purged") return;
      purgeMemory(app.ctx, i.id, "owner");
      app.committed([i.id]);
      markPurgePending(app);
    },
  }),
  "memory.resolve": action({
    // A contested pair: the kept memory becomes active (T0 confirms it), the others are superseded by it.
    input: z.strictObject({ keep: MemId }),
    uv: false,
    run(app, i) {
      if (memoryStatus(app, i.keep) !== "contested") throw new ActionError("this memory is not contested");
      const others = (prepared(app.ctx.db, "SELECT CASE WHEN memory_id = ? THEN other_memory_id ELSE memory_id END other FROM memory_contest WHERE (memory_id = ? OR other_memory_id = ?) AND resolved_at IS NULL").all(i.keep, i.keep, i.keep) as { other: string }[]).map((r) => r.other);
      transaction(app.ctx.db, () => {
        const now = iso(app.ctx.clock.now());
        for (const o of others) setMemoryStatus(app.ctx, o, "superseded", i.keep);
        setMemoryStatus(app.ctx, i.keep, "active");
        prepared(app.ctx.db, "UPDATE memory_contest SET resolved_at = ?, resolution = CASE WHEN memory_id = ? THEN 'kept_this' ELSE 'kept_other' END WHERE (memory_id = ? OR other_memory_id = ?) AND resolved_at IS NULL").run(now, i.keep, i.keep, i.keep);
        appendEvent(app.ctx, { actor: "owner", op: "memory.resolve", refs: { memory_id: i.keep, superseded: others } });
      });
      app.committed([i.keep, ...others]);
    },
  }),
  "review.decide": action({
    // Approving a sensitive memory also says which apps may recall it (§8.1): its category joins their allow-list.
    input: z.strictObject({ id: Id("rev"), approve: z.boolean(), clients: z.array(ClientId).max(50).optional() }),
    // Approving held instructions and sensitive memories is a §3.4 action.
    uv: (i, app) => i.approve && ["instruction", "sensitive", "import_sensitive", "render_sensitive"].includes(
      (prepared(app.ctx.db, "SELECT kind FROM review_item WHERE id = ?").get(i.id) as { kind: string } | undefined)?.kind ?? ""),
    run(app, i) {
      const category = (prepared(app.ctx.db, "SELECT m.sensitivity_category c FROM review_item r JOIN memory m ON m.id = r.memory_id WHERE r.id = ? AND r.kind = 'sensitive'").get(i.id) as { c: string | null } | undefined)?.c;
      const touched = resolveReviews(app.ctx, [{ id: i.id, resolution: i.approve ? "approved" : "rejected" }], app.config.retention.forgotten_purge_days);
      if (i.approve && category && i.clients && i.clients.length > 0) {
        transaction(app.ctx.db, () => {
          for (const clientId of i.clients ?? []) {
            const row = prepared(app.ctx.db, "SELECT sensitive_allow_json FROM client_policy WHERE client_id = ? AND revoked_at IS NULL").get(clientId) as { sensitive_allow_json: string } | undefined;
            if (!row) continue;
            const allowed = new Set(JSON.parse(row.sensitive_allow_json) as string[]).add(category);
            prepared(app.ctx.db, "UPDATE client_policy SET sensitive_allow_json = ? WHERE client_id = ?").run(JSON.stringify([...allowed].sort()), clientId);
          }
          appendEvent(app.ctx, { actor: "owner", op: "client.sensitive_allow", refs: { category, clients: i.clients ?? [] } });
        });
        app.sessions.invalidate();
      }
      app.committed(touched);
    },
  }),
  "observation.forget": action({
    input: z.strictObject({ id: Id("obs") }),
    uv: false,
    run(app, i) {
      transaction(app.ctx.db, () => {
        if (Number(prepared(app.ctx.db, "UPDATE observation SET status = 'forgotten' WHERE id = ? AND status = 'open'").run(i.id).changes) === 0) throw new ActionError("no open observation with that id");
        appendEvent(app.ctx, { actor: "owner", op: "observation.forget", refs: { observation_id: i.id } });
      });
    },
  }),
  "observation.promote": action({
    // The owner saves the observation's text as a T0 memory; the observation closes.
    input: z.strictObject({ id: Id("obs") }),
    uv: false,
    async run(app, i) {
      const o = prepared(app.ctx.db, "SELECT content FROM observation WHERE id = ? AND status = 'open' AND content IS NOT NULL").get(i.id) as { content: string } | undefined;
      const slot = slotOf(app, "observation", i.id);
      if (!o || !slot) throw new ActionError("no open observation with that id");
      const r = await save(app.write, OWNER, { content: o.content, ...slot, why_durable: "promoted by the owner", explicit_request: true, scope: "global", change: "update" },
        { idempotencyKey: app.ctx.ids.newId("adm", app.ctx.clock.now()), observedAt: app.ctx.clock.now() });
      transaction(app.ctx.db, () => {
        prepared(app.ctx.db, "UPDATE observation SET status = 'promoted', promoted_memory_id = ? WHERE id = ?").run(r.kind === "result" ? (r.outcome.id ?? null) : null, i.id);
        appendEvent(app.ctx, { actor: "owner", op: "observation.promote", refs: { observation_id: i.id, memory_id: r.kind === "result" ? (r.outcome.id ?? null) : null } });
      });
    },
  }),
  "section.approve": action({
    input: z.strictObject({ id: SectionId }),
    uv: false,
    run(app, i) {
      transaction(app.ctx.db, () => {
        prepared(app.ctx.db, "UPDATE section SET approved = 1 WHERE id = ? AND status = 'active'").run(i.id);
        appendEvent(app.ctx, { actor: "owner", op: "section.approve", refs: { section_id: i.id } });
      });
    },
  }),
  "section.rename": action({
    input: z.strictObject({ id: SectionId, name: z.string().trim().min(1).max(32) }),
    uv: false,
    run(app, i) {
      transaction(app.ctx.db, () => {
        const taken = prepared(app.ctx.db, "SELECT 1 FROM section WHERE name = ? AND id <> ?").get(i.name, i.id);
        if (taken) throw new ActionError("another section has that name");
        prepared(app.ctx.db, "UPDATE section SET name = ?, approved = 1 WHERE id = ?").run(i.name, i.id);
        appendEvent(app.ctx, { actor: "owner", op: "section.rename", refs: { section_id: i.id } });
      });
    },
  }),
  "section.undo": action({
    // A dynamic section is undone: its memories return to Unsorted (memory-policy.md §9.2).
    input: z.strictObject({ id: SectionId }),
    uv: false,
    run(app, i) {
      const moved = transaction(app.ctx.db, () => {
        const s = prepared(app.ctx.db, "SELECT origin FROM section WHERE id = ? AND status = 'active'").get(i.id) as { origin: string } | undefined;
        if (s?.origin !== "dynamic") throw new ActionError("only a dynamic section can be undone");
        const ids = (prepared(app.ctx.db, "SELECT id FROM memory WHERE section_id = ?").all(i.id) as { id: string }[]).map((r) => r.id);
        prepared(app.ctx.db, "UPDATE memory SET section_id = 'sec_unsorted' WHERE section_id = ?").run(i.id);
        prepared(app.ctx.db, "UPDATE section SET status = 'undone' WHERE id = ?").run(i.id);
        appendEvent(app.ctx, { actor: "owner", op: "section.undo", refs: { section_id: i.id }, undo: { moved: ids } });
        return ids;
      });
      app.committed(moved);
    },
  }),
  "section.merge": action({
    input: z.strictObject({ from: SectionId, into: SectionId }),
    uv: false,
    run(app, i) {
      if (i.from === i.into) throw new ActionError("choose two different sections");
      const moved = transaction(app.ctx.db, () => {
        const ids = (prepared(app.ctx.db, "SELECT id FROM memory WHERE section_id = ?").all(i.from) as { id: string }[]).map((r) => r.id);
        prepared(app.ctx.db, "UPDATE memory SET section_id = ? WHERE section_id = ?").run(i.into, i.from);
        prepared(app.ctx.db, "UPDATE section SET status = 'merged', merged_into = ? WHERE id = ?").run(i.into, i.from);
        appendEvent(app.ctx, { actor: "owner", op: "section.merge", refs: { section_id: i.from, into: i.into }, undo: { moved: ids } });
        return ids;
      });
      app.committed(moved);
    },
  }),
  "attribute.add": action({
    input: z.strictObject({
      name: z.string().regex(/^(self|person|project|org|place|thing)\.[a-z][a-z_]{1,40}$/u),
      cardinality: z.enum(["one", "many"]),
      section: SectionId,
      description: z.string().trim().min(1).max(200),
    }),
    uv: false,
    run(app, i) {
      const [entityType] = i.name.split(".");
      transaction(app.ctx.db, () => {
        if (prepared(app.ctx.db, "SELECT 1 FROM attribute WHERE name = ?").get(i.name)) throw new ActionError("that attribute exists");
        const id = `att_${i.name.replaceAll(".", "_")}`;
        prepared(app.ctx.db, `INSERT INTO attribute (id, name, entity_type, cardinality, section_id, taste_class, profile_key, restricted, aliases_json, sort_order, origin, description)
          VALUES (?, ?, ?, ?, ?, 0, 0, 0, '[]', 1000, 'owner', ?)`).run(id, i.name, entityType ?? "self", i.cardinality, i.section, i.description);
        appendEvent(app.ctx, { actor: "owner", op: "attribute.add", refs: { attribute_id: id } });
      });
    },
  }),
  "repo.set": action({
    input: z.strictObject({ repo_key: z.string().regex(/^rk_[0-9a-f]{32}$/u), enabled: z.boolean(), capture: z.boolean() }),
    uv: false,
    async run(app, i) {
      const repo = prepared(app.ctx.db, "SELECT display_name FROM repo WHERE repo_key = ?").get(i.repo_key) as { display_name: string } | undefined;
      if (!repo) throw new ActionError("no such repository");
      if (!i.enabled) return repoDisable(app.write, { repo_key: i.repo_key });
      return repoEnable(app.write, { repo_key: i.repo_key, display_name: repo.display_name, capture: i.capture });
    },
  }),
  "client.policy": action({
    input: z.strictObject({
      client_id: ClientId,
      write: z.boolean(),
      sections: z.enum(["all", "restricted"]),
      save_floor: z.enum(["none", "observation"]),
      elicitation: z.enum(["none", "verified"]),
    }),
    uv: true,
    run(app, i) {
      const c = prepared(app.ctx.db, "SELECT vendor FROM client_policy WHERE client_id = ? AND revoked_at IS NULL").get(i.client_id) as { vendor: string } | undefined;
      if (!c) throw new ActionError("no such app");
      // A client limited to some sections always keeps the observation floor (write-path.md §5).
      if (i.sections === "restricted" && i.save_floor === "none") throw new ActionError("an app limited to some sections keeps the observation floor");
      // Only Claude shows an elicitation question to the person (ADR-0106).
      if (i.elicitation === "verified" && c.vendor !== "claude") throw new ActionError("only Claude can confirm saves with a question");
      transaction(app.ctx.db, () => {
        prepared(app.ctx.db, "UPDATE client_policy SET write = ?, section_allow_json = ?, save_floor = ?, elicitation = ? WHERE client_id = ?")
          .run(i.write ? 1 : 0, JSON.stringify(i.sections === "all" ? ["*"] : RESTRICTED_SECTIONS), i.save_floor, i.elicitation, i.client_id);
        appendEvent(app.ctx, { actor: "owner", op: "client.policy", refs: { client_id: i.client_id } });
      });
      app.sessions.invalidate();
    },
  }),
  "client.revoke": action({
    input: z.strictObject({ client_id: ClientId }),
    uv: true,
    run(app, i) {
      transaction(app.ctx.db, () => {
        revokeClientGrants(app.ctx, i.client_id);
        prepared(app.ctx.db, "UPDATE client_policy SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").run(iso(app.ctx.clock.now()), i.client_id);
        appendEvent(app.ctx, { actor: "owner", op: "client.revoke", refs: { client_id: i.client_id } });
      });
    },
  }),
  "client.revert": action({
    input: z.strictObject({ client_id: ClientId, since: z.iso.datetime(), until: z.iso.datetime() }),
    uv: true,
    run(app, i) {
      return revertClient(app, i.client_id, i.since, i.until);
    },
  }),
  "recipient.add": action({
    input: z.strictObject({ recipient: z.string().regex(/^age1[0-9a-z]{58}$/u), label: z.string().trim().min(1).max(64) }),
    uv: true,
    run(app, i) {
      const fingerprint = createHash("sha256").update(i.recipient).digest("hex").slice(0, 16);
      transaction(app.ctx.db, () => {
        if (prepared(app.ctx.db, "SELECT 1 FROM export_recipient WHERE recipient = ? AND revoked_at IS NULL").get(i.recipient)) throw new ActionError("that key is already registered");
        const id = app.ctx.ids.newId("exr", app.ctx.clock.now());
        prepared(app.ctx.db, "INSERT INTO export_recipient (id, recipient, fingerprint, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, i.recipient, fingerprint, i.label, iso(app.ctx.clock.now()));
        appendEvent(app.ctx, { actor: "owner", op: "recipient.add", refs: { recipient_id: id } });
      });
    },
  }),
  "recipient.revoke": action({
    input: z.strictObject({ id: Id("exr") }),
    uv: true,
    run(app, i) {
      transaction(app.ctx.db, () => {
        prepared(app.ctx.db, "UPDATE export_recipient SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(iso(app.ctx.clock.now()), i.id);
        appendEvent(app.ctx, { actor: "owner", op: "recipient.revoke", refs: { recipient_id: i.id } });
      });
    },
  }),
  "alert.ack": action({
    input: z.strictObject({ id: Id("alr") }),
    uv: false,
    run(app, i) {
      app.alerts.acknowledge(i.id);
    },
  }),
} as const;

export type ActionName = keyof typeof ACTIONS;
export const isAction = (name: string): name is ActionName => Object.hasOwn(ACTIONS, name);

/**
 * Undoes what one app did in a time window (auth-and-security.md §8.1): memories it created are
 * forgotten (undoable for 30 days), versions it wrote over another are reverted by a T0 version
 * restoring the earlier text, and its open observations close. Returns what it changed.
 */
export async function revertClient(app: App, clientId: string, since: string, until: string): Promise<{ forgotten: number; restored: number; observations: number }> {
  const db = app.ctx.db;
  const events = prepared(db, "SELECT op, refs_json, undo_json FROM event WHERE actor = ? AND at >= ? AND at <= ? ORDER BY id DESC").all(clientId, since, until) as { op: string; refs_json: string; undo_json: string | null }[];
  let forgotten = 0;
  let restored = 0;
  let observations = 0;
  const done = new Set<string>();
  for (const e of events) {
    const refs = JSON.parse(e.refs_json) as { memory_id?: string; observation_id?: string };
    if (e.op === "memory.insert" && refs.memory_id && !done.has(refs.memory_id)) {
      done.add(refs.memory_id);
      const status = (prepared(db, "SELECT status FROM memory WHERE id = ?").get(refs.memory_id) as { status: string } | undefined)?.status;
      if (status && status !== "forgotten" && status !== "purged") {
        forgetByOwner(app.ctx, refs.memory_id, app.config.retention.forgotten_purge_days);
        forgotten++;
      }
    } else if ((e.op === "memory.update" || e.op === "memory.correction" || e.op === "memory.extension") && refs.memory_id && e.undo_json && !done.has(refs.memory_id)) {
      done.add(refs.memory_id);
      const prior = (JSON.parse(e.undo_json) as { prior_version_id?: string }).prior_version_id;
      const text = prior ? (prepared(db, "SELECT content FROM memory_version WHERE id = ?").get(prior) as { content: string | null } | undefined)?.content : undefined;
      if (text) {
        await ACTIONS["memory.edit"].run(app, { id: refs.memory_id, content: text, change: "correction" });
        restored++;
      }
    } else if (e.op === "observation.create" && refs.observation_id) {
      observations += Number(prepared(db, "UPDATE observation SET status = 'expired' WHERE id = ? AND status = 'open'").run(refs.observation_id).changes);
    }
  }
  appendEvent(app.ctx, { actor: "owner", op: "client.revert", refs: { client_id: clientId, since, until, forgotten, restored, observations } });
  app.committed([...done]);
  return { forgotten, restored, observations };
}

/** Runs one action: the input is validated here; the caller has already checked the session, CSRF and UV. */
export async function runAction(app: App, name: ActionName, input: unknown): Promise<unknown> {
  const a = ACTIONS[name] as Action<z.ZodType>;
  const parsed = a.input.safeParse(input);
  if (!parsed.success) throw new ActionError(parsed.error.issues[0]?.message ?? "invalid input");
  try {
    return await a.run(app, parsed.data);
  } catch (e) {
    if (e instanceof WriteError) throw new ActionError(e.message);
    throw e;
  }
}

export function needsUv(app: App, name: ActionName, input: unknown): boolean {
  const a = ACTIONS[name] as Action<z.ZodType>;
  const parsed = a.input.safeParse(input);
  if (!parsed.success) return false;
  return typeof a.uv === "function" ? a.uv(parsed.data, app) : a.uv;
}

