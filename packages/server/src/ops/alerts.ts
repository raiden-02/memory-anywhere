// Alerts (operations.md §2): things the owner should know about, delivered three ways.
//
//   raise(kind, …) ──► alert row (admin UI banner and list; memory_status warnings)
//                  ├─► outbox alert-<kind>.json  → SNS email      (kinds delivered "immediate", aws mode)
//                  └─► daily digest-<date>.json  → SNS email      (kinds delivered "digest", aws mode)
//
// An open alert of the same kind and subject is counted again instead of repeated, and an
// immediate alert is emailed at most once an hour while it stays open, so a misbehaving client
// cannot flood the owner. Details hold counts and ids only, never memory content: strings with
// spaces are refused.

import type { StoreContext } from "../store/context.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import type { Outbox } from "./outbox.ts";

type Delivery = "immediate" | "digest" | "both";

/** The alerts this server raises, and how each is delivered (operations.md §2). */
export const ALERT_DELIVERY = {
  grant_created: "both",
  pairing_race: "immediate",
  owner_reset_requested: "immediate",
  restored: "immediate",
  store_imported: "immediate",
  stepup_unexpected: "immediate",
  refresh_reuse: "immediate",
  auth_fail: "immediate",
  passkey_clone: "immediate",
  save_quota: "digest",
  forget_quota: "immediate",
  read_budget: "digest", // immediate at 100%, raised with `immediate: true`
  supersede_remote: "digest",
  disk_low: "immediate",
  llm_cap: "digest",
  job_failed: "digest",
} as const satisfies Record<string, Delivery>;
// Not raised here: dns_mismatch and update_failed (the updater writes them to the outbox), backup_lag
// (a CloudWatch metric filter), kms_or_bucket_change and cost (EventBridge and Budgets publish to SNS).

export type AlertKind = keyof typeof ALERT_DELIVERY;
export type AlertDetails = Readonly<Record<string, number | string>>;

export interface AlertRow {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subject: string;
  readonly count: number;
  readonly at: string;
  readonly last_at: string;
  readonly details: AlertDetails;
}

interface RaiseOptions {
  /** What the alert is about when a kind has several (a client id, a job kind). */
  readonly subject?: string;
  /** Email now even if the kind is normally only in the digest (read budget at 100%). */
  readonly immediate?: boolean;
}

const RENOTIFY_MS = HOUR_MS;
/** An id, code or number: no spaces, so no sentence from a memory can ride along. */
const SAFE_VALUE = /^[\w.:@-]{0,80}$/u;

export class Alerts {
  readonly #ctx: StoreContext;
  readonly #outbox: Outbox;

  constructor(ctx: StoreContext, outbox: Outbox) {
    this.#ctx = ctx;
    this.#outbox = outbox;
  }

  /** Records the alert (or counts a repeat of an open one) and emails it if it is immediate. Returns its id. */
  raise(kind: AlertKind, details: AlertDetails = {}, o: RaiseOptions = {}): string {
    for (const [k, v] of Object.entries(details)) {
      if (typeof v === "string" && !SAFE_VALUE.test(v)) throw new Error(`alert ${kind}: detail ${k} is not an id or code`);
    }
    const { db, clock, ids } = this.#ctx;
    const now = clock.now();
    const subject = o.subject ?? "";
    if (!SAFE_VALUE.test(subject)) throw new Error(`alert ${kind}: subject is not an id or code`);
    const open = prepared(db, "SELECT id, count, details_json, notified_at FROM alert WHERE kind = ? AND subject = ? AND acknowledged_at IS NULL ORDER BY at DESC LIMIT 1")
      .get(kind, subject) as { id: string; count: number; details_json: string; notified_at: string | null } | undefined;
    let id: string;
    let count: number;
    let notifiedAt: string | null;
    if (open) {
      id = open.id;
      count = open.count + 1;
      notifiedAt = open.notified_at;
      const merged = { ...(JSON.parse(open.details_json) as AlertDetails), ...details };
      prepared(db, "UPDATE alert SET count = ?, last_at = ?, details_json = ? WHERE id = ?").run(count, iso(now), JSON.stringify(merged), id);
    } else {
      id = ids.newId("alr", now);
      count = 1;
      notifiedAt = null;
      prepared(db, "INSERT INTO alert (id, kind, at, details_json, subject, count, last_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(id, kind, iso(now), JSON.stringify(details), subject, iso(now));
    }
    const delivery: Delivery = ALERT_DELIVERY[kind];
    const immediate = o.immediate === true || delivery !== "digest";
    if (immediate && (notifiedAt === null || Date.parse(notifiedAt) + RENOTIFY_MS <= now)) {
      const sent = this.#outbox.send(`alert-${kind}.json`, JSON.stringify({ id: kind, subject, count, at: iso(now), details }));
      if (sent) prepared(db, "UPDATE alert SET notified_at = ? WHERE id = ?").run(iso(now), id);
    }
    return id;
  }

  /** Open alerts, newest first: the admin UI banner and `memory_status` warnings. */
  open(): AlertRow[] {
    return (prepared(this.#ctx.db, "SELECT id, kind, subject, count, at, last_at, details_json FROM alert WHERE acknowledged_at IS NULL ORDER BY last_at DESC").all() as {
      id: string; kind: AlertKind; subject: string; count: number; at: string; last_at: string | null; details_json: string;
    }[]).map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, count: r.count, at: r.at, last_at: r.last_at ?? r.at, details: JSON.parse(r.details_json) as AlertDetails }));
  }

  acknowledge(id: string): void {
    prepared(this.#ctx.db, "UPDATE alert SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL").run(iso(this.#ctx.clock.now()), id);
  }

  /**
   * The daily digest: every digest-delivered alert raised or repeated since its last digest, sent
   * to the outbox as `digest-<date>.json`. Returns how many alerts it listed (0: nothing sent).
   */
  sendDigest(): number {
    const { db, clock } = this.#ctx;
    const now = iso(clock.now());
    const kinds = Object.entries(ALERT_DELIVERY).filter(([, d]) => d !== "immediate").map(([k]) => k);
    const rows = (prepared(db, `SELECT id, kind, subject, count, at, last_at FROM alert
      WHERE kind IN (${kinds.map(() => "?").join(",")}) AND (digested_at IS NULL OR last_at > digested_at) ORDER BY kind, subject`).all(...kinds) as {
      id: string; kind: string; subject: string; count: number; at: string; last_at: string | null;
    }[]);
    if (rows.length === 0) return 0;
    const body = { date: now.slice(0, 10), alerts: rows.map((r) => ({ kind: r.kind, subject: r.subject, count: r.count, first_at: r.at, last_at: r.last_at ?? r.at })) };
    if (!this.#outbox.send(`digest-${body.date}.json`, JSON.stringify(body))) return 0;
    const mark = prepared(db, "UPDATE alert SET digested_at = ? WHERE id = ?");
    for (const r of rows) mark.run(now, r.id);
    return rows.length;
  }
}
