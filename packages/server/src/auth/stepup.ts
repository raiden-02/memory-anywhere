// Step-up for the CLI's owner commands (auth-and-security.md §6; mcp-interface.md §7). No admin
// credential is kept on any PC: each command needs the owner's passkey, given on a page whose text
// the server writes, so an agent on the PC can ask but never approve or reword.
//
//   CLI  POST /v1/admin/stepup {command, args}        ──► request: args hashed, approval text rendered here
//   CLI  prints user code, opens admin.{host}/approve/<id>
//   owner reads the text, checks the code, approves with a passkey (twice + typed fingerprint for an unknown export key)
//   CLI  GET /v1/admin/stepup/<id> every 2 s           ──► token (once): single use, 10 min (import: 60 min, reusable)
//   CLI  POST /v1/admin/<command> + MA-Step-Up: <token> ──► runs only if the body hashes to the approved args
//
// Three denied or expired requests in an hour raise `stepup_unexpected`.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { ADMIN_ARGS, AdminCommand, type AdminCommandT } from "@memory-anywhere/contracts/schemas/v1";
import type { Alerts } from "../ops/alerts.ts";
import type { StoreContext } from "../store/context.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { sha256Hex } from "./adapter.ts";

const REQUEST_MS = 5 * 60_000;
const TOKEN_MS = 10 * 60_000;
const IMPORT_TOKEN_MS = 60 * 60_000;
const ARGS_MAX = 4096;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const STEP_UP_HEADER = "ma-step-up";

/** JSON with object keys sorted at every level: the same arguments always hash the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export type StepUpStatus = { status: "pending" | "denied" | "expired" } | { status: "approved"; token?: string; token_expires_in?: number; import_batch_id?: string };

export interface StepUpView {
  readonly id: string;
  readonly command: AdminCommandT;
  readonly text: string;
  readonly userCode: string;
  readonly needsSecondConfirm: boolean;
  /** The last 8 hex characters the owner must type for an unknown export key. */
  readonly confirmSuffix: string | undefined;
  readonly open: boolean;
}

export class StepUps {
  readonly #ctx: StoreContext;
  readonly #alerts: Alerts;
  readonly #adminUrl: string;
  /** Requests whose first of two approvals is done (an export to an unknown key), with when. */
  readonly #firstApproval = new Map<string, number>();

  constructor(ctx: StoreContext, alerts: Alerts, adminUrl: string) {
    this.#ctx = ctx;
    this.#alerts = alerts;
    this.#adminUrl = adminUrl;
  }

  /** Where the owner approves a request: `https://admin.{host}/approve/<id>`. */
  approveUrl(id: string): string {
    return `${this.#adminUrl}/approve/${id}`;
  }

  #now(): number {
    return this.#ctx.clock.now();
  }

  /** A new request from the PC grant `clientId`; errors are returned as codes for the API. */
  create(clientId: string, command: unknown, args: unknown): { ok: true; id: string; userCode: string } | { ok: false; code: "INVALID_INPUT"; message: string } {
    const cmd = AdminCommand.safeParse(command);
    if (!cmd.success) return { ok: false, code: "INVALID_INPUT", message: "unknown command" };
    const parsed = ADMIN_ARGS[cmd.data].safeParse(args);
    if (!parsed.success) return { ok: false, code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "invalid arguments" };
    const argsJson = canonicalJson(parsed.data);
    if (Buffer.byteLength(argsJson) > ARGS_MAX) return { ok: false, code: "INVALID_INPUT", message: "arguments over 4 KiB" };
    const { text, needsSecondConfirm } = this.#render(cmd.data, parsed.data as Record<string, unknown>);
    const { db, ids } = this.#ctx;
    const now = this.#now();
    const id = ids.newId("stp", now);
    const userCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    prepared(db, `INSERT INTO stepup_request (id, command, args_json, args_sha256, rendered_text, needs_second_confirm, client_id, user_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cmd.data, argsJson, sha256Hex(argsJson), text, needsSecondConfirm ? 1 : 0, clientId, userCode, iso(now), iso(now + REQUEST_MS));
    this.#checkUnexpected();
    return { ok: true, id, userCode };
  }

  /** What the approval page shows. */
  view(id: string): StepUpView | undefined {
    const r = prepared(this.#ctx.db, "SELECT id, command, rendered_text, user_code, needs_second_confirm, args_json, expires_at, approved_at, denied_at FROM stepup_request WHERE id = ?").get(id) as
      | { id: string; command: AdminCommandT; rendered_text: string; user_code: string; needs_second_confirm: number; args_json: string; expires_at: string; approved_at: string | null; denied_at: string | null }
      | undefined;
    if (!r) return undefined;
    const recipient = (JSON.parse(r.args_json) as { recipient?: string }).recipient;
    return {
      id: r.id,
      command: r.command,
      text: r.rendered_text,
      userCode: r.user_code,
      needsSecondConfirm: r.needs_second_confirm === 1,
      confirmSuffix: recipient ? fingerprint(recipient).replaceAll(" ", "").slice(-8) : undefined,
      open: r.approved_at === null && r.denied_at === null && r.expires_at > iso(this.#now()),
    };
  }

  /**
   * The owner approved with a passkey. An export to an unknown key needs two approvals, the first
   * with the key's last 8 hex characters typed; returns "second" when one more is needed.
   */
  approve(id: string, typedSuffix: string | undefined): "approved" | "second" | "wrong_suffix" | "closed" {
    const v = this.view(id);
    if (!v?.open) return "closed";
    if (v.needsSecondConfirm) {
      const first = this.#firstApproval.get(id);
      if (first === undefined) {
        if ((typedSuffix ?? "").trim().toLowerCase() !== v.confirmSuffix) return "wrong_suffix";
        this.#firstApproval.set(id, this.#now());
        return "second";
      }
      this.#firstApproval.delete(id);
    }
    prepared(this.#ctx.db, "UPDATE stepup_request SET approved_at = ? WHERE id = ? AND approved_at IS NULL AND denied_at IS NULL").run(iso(this.#now()), id);
    return "approved";
  }

  deny(id: string): void {
    prepared(this.#ctx.db, "UPDATE stepup_request SET denied_at = ? WHERE id = ? AND approved_at IS NULL AND denied_at IS NULL").run(iso(this.#now()), id);
    this.#firstApproval.delete(id);
    this.#checkUnexpected();
  }

  /** The CLI's poll: the token is handed out once, on the first poll after approval. */
  status(clientId: string, id: string): StepUpStatus | undefined {
    const r = prepared(this.#ctx.db, "SELECT command, expires_at, approved_at, denied_at, token_hash, import_batch_id FROM stepup_request WHERE id = ? AND client_id = ?").get(id, clientId) as
      | { command: AdminCommandT; expires_at: string; approved_at: string | null; denied_at: string | null; token_hash: string | null; import_batch_id: string | null }
      | undefined;
    if (!r) return undefined;
    if (r.denied_at) return { status: "denied" };
    if (!r.approved_at) {
      if (r.expires_at > iso(this.#now())) return { status: "pending" };
      this.#checkUnexpected();
      return { status: "expired" };
    }
    if (r.token_hash) return { status: "approved" };
    const token = randomBytes(32).toString("base64url");
    const ttl = r.command === "import" ? IMPORT_TOKEN_MS : TOKEN_MS;
    prepared(this.#ctx.db, "UPDATE stepup_request SET token_hash = ?, token_expires_at = ? WHERE id = ?").run(sha256Hex(token), iso(this.#now() + ttl), id);
    return { status: "approved", token, token_expires_in: ttl / 1000, ...(r.import_batch_id ? { import_batch_id: r.import_batch_id } : {}) };
  }

  /**
   * `/v1/admin/<command>`: the step-up token must be this client's, for this command, unexpired,
   * unused, and for exactly these arguments. Returns the approved request's id, or undefined.
   */
  consume(clientId: string, token: string | undefined, command: string, args: unknown): string | undefined {
    if (!token) return undefined;
    const cmd = AdminCommand.safeParse(command);
    if (!cmd.success) return undefined;
    const parsed = ADMIN_ARGS[cmd.data].safeParse(args);
    if (!parsed.success) return undefined;
    const r = prepared(this.#ctx.db, "SELECT id, args_sha256, uses, token_expires_at FROM stepup_request WHERE token_hash = ? AND client_id = ? AND command = ?")
      .get(sha256Hex(token), clientId, cmd.data) as { id: string; args_sha256: string; uses: number; token_expires_at: string } | undefined;
    if (!r || r.token_expires_at <= iso(this.#now())) return undefined;
    if (cmd.data !== "import" && (r.uses > 0 || r.args_sha256 !== sha256Hex(canonicalJson(parsed.data)))) return undefined;
    prepared(this.#ctx.db, "UPDATE stepup_request SET uses = uses + 1 WHERE id = ?").run(r.id);
    return r.id;
  }

  #checkUnexpected(): void {
    const now = this.#now();
    const n = (prepared(this.#ctx.db, `SELECT count(*) n FROM stepup_request
      WHERE (denied_at > ?) OR (approved_at IS NULL AND denied_at IS NULL AND expires_at > ? AND expires_at <= ?)`).get(iso(now - HOUR_MS), iso(now - HOUR_MS), iso(now)) as { n: number }).n;
    if (n >= 3) this.#alerts.raise("stepup_unexpected", { requests: n });
  }

  /** The approval text (§6.2): written here from the parsed arguments and the store, never by the client. */
  #render(command: AdminCommandT, a: Record<string, unknown>): { text: string; needsSecondConfirm: boolean } {
    const db = this.#ctx.db;
    const lines: string[] = [];
    let needsSecondConfirm = false;
    switch (command) {
      case "repo-enable": {
        lines.push(`Enable memory in repository "${String(a["display_name"])}".`, `Prompt capture: ${a["capture"] ? "on" : "off"}.`);
        const track = a["track"] as { name: string } | undefined;
        lines.push(track ? `Track it as project "${track.name}".` : "No project is tracked.");
        break;
      }
      case "repo-disable": {
        const name = (prepared(db, "SELECT display_name FROM repo WHERE repo_key = ?").get(String(a["repo_key"])) as { display_name: string } | undefined)?.display_name;
        lines.push(`Disable memory in repository "${name ?? String(a["repo_key"])}".`);
        break;
      }
      case "project-track":
        lines.push(`Track a project named "${String(a["name"])}" for this repository.`);
        break;
      case "project-add": {
        lines.push(`Add project "${String(a["name"])}".`);
        const aliases = (a["aliases"] as string[] | undefined) ?? [];
        if (aliases.length > 0) lines.push(`Also called: ${aliases.join(", ")}.`);
        if (a["status"]) lines.push(`Status: ${String(a["status"])}.`);
        if (a["goal"]) lines.push(`Goal: ${String(a["goal"])}`);
        break;
      }
      case "review": {
        const item = prepared(db, `SELECT r.kind, coalesce(v.content, '') content FROM review_item r
          LEFT JOIN memory_version v ON v.id = (SELECT max(id) FROM memory_version WHERE memory_id = r.memory_id) WHERE r.id = ?`);
        for (const [verb, ids] of [["Approve", a["approve"]], ["Reject", a["reject"]]] as const) {
          for (const id of (ids as string[] | undefined) ?? []) {
            const r = item.get(id) as { kind: string; content: string } | undefined;
            lines.push(`${verb} ${r?.kind ?? "unknown"} item: ${(r?.content ?? id).slice(0, 200)}`);
          }
        }
        break;
      }
      case "export": {
        const kind = a["include_auth"] ? "full, with sign-in data" : a["section"] === "projects" ? "projects only" : "full";
        const recipient = a["recipient"] as string | undefined;
        const known = recipient
          ? (prepared(db, "SELECT label FROM export_recipient WHERE recipient = ? AND revoked_at IS NULL").get(recipient) as { label: string } | undefined)
          : (prepared(db, "SELECT label, recipient FROM export_recipient WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1").get() as { label: string; recipient: string } | undefined);
        const count = (prepared(db, "SELECT count(*) n FROM memory WHERE status IN ('active','contested')").get() as { n: number }).n;
        lines.push(`Export (${kind}) of ${count} memories.`);
        const key = recipient ?? (known as { recipient?: string } | undefined)?.recipient;
        if (known && key) lines.push(`Encrypted to "${known.label}", key ${fingerprint(key)}.`);
        if (recipient && !known) {
          needsSecondConfirm = true;
          lines.push(`WARNING: This key is not one of your registered export keys. Key ${fingerprint(recipient)}.`);
        }
        if (!key) lines.push("No export key is registered: add one in the admin UI first.");
        if (a["include_auth"]) lines.push("WARNING: this file includes sign-in data and can take over the store.");
        break;
      }
      case "import":
        lines.push(`Import from source "${String(a["source"])}"${a["since"] ? ` since ${String(a["since"])}` : ""}${a["until"] ? ` until ${String(a["until"])}` : ""}.`);
        break;
    }
    return { text: lines.join("\n"), needsSecondConfirm };
  }
}

/** First 16 hex of sha256(recipient), in four groups (data-model.md §10). */
export function fingerprint(recipient: string): string {
  const hex = createHash("sha256").update(recipient).digest("hex").slice(0, 16);
  return hex.match(/.{4}/gu)?.join(" ") ?? hex;
}
