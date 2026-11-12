// Shared types of the write path (write-path.md). A save travels as:
//   SaveRequest (from a tool or /v1) + Caller (from the grant and channel)
//   → Verified (step 4) → Screens (step 4.7) → Resolution (step 6, deterministic part)
//   → Decision (step 5) → store rules (step 7) → WriteOutcome.

import type { KindT, OutcomeT, TierT } from "@memory-anywhere/contracts/schemas/common";
import type { ReasonCode } from "@memory-anywhere/contracts/reasons";
import type { SensitiveCategory } from "../policy/generated.ts";

/** Write channels (write-path.md §2.1). */
export type Channel = "mcp" | "spool_save" | "capture" | "import" | "admin" | "promotion" | "review_approve";

export type ClientClass = "chat" | "coding";

/** Trust tier as stored: 0 (owner) … 3 (import). */
export type TierNum = 0 | 1 | 2 | 3;

export const tierLabel = (t: TierNum): TierT => `T${t}` as TierT;

export const CHANNEL_TIER: Readonly<Record<Exclude<Channel, "promotion">, TierNum>> = {
  mcp: 2, spool_save: 2, capture: 2, import: 3, admin: 0, review_approve: 0,
};

/** Who is writing, decided by the server from the grant, the channel and headers. */
export interface Caller {
  readonly clientId: string;
  readonly clientClass: ClientClass;
  readonly channel: Channel;
  readonly tier: TierNum;
  /** write-path.md §2.2. */
  readonly sessionKey: string;
  /** Coding callers: the repo the call came from (`none` outside an allowed repo). */
  readonly repoKey: string | undefined;
  /** `MA-Tool` header or vendor (untrusted label). */
  readonly tool: string | undefined;
  /** client_policy.save_floor = observation. */
  readonly floored: boolean;
  /** The client may ask the human a question (client_policy.elicitation = verified and declared). */
  readonly canElicit: boolean;
  /** The human's answer to an elicitation, when this call is the retry that carries it. */
  readonly elicitationAnswer: boolean | undefined;
}

/** A save as the model sent it (memory_save input after schema validation). */
export interface SaveRequest {
  readonly content: string;
  readonly kind: KindT;
  readonly why_durable: string;
  readonly user_words?: string | undefined;
  readonly explicit_request: boolean;
  readonly section?: string | undefined;
  readonly entity: string;
  readonly attribute?: string | undefined;
  readonly scope: "global" | "repo";
  readonly supersedes?: string | undefined;
  readonly change: "update" | "correction";
  readonly valid_from?: string | undefined;
  readonly expires_on?: string | undefined;
  readonly policy_version?: string | undefined;
}

/** Step 4 results (write-path.md §4). */
export interface Verified {
  readonly content: string;
  readonly userWords: string | undefined;
  readonly whyDurable: string;
  readonly contentHash: string;
  readonly qualifyingUserWords: boolean;
  readonly rememberIntent: boolean;
  /** Coding-tool user_words were not found in the session's prompts (reason suffix). */
  readonly userWordsUnsupported: boolean;
}

/** Step 4.7 screens, computed once. */
export interface Screens {
  readonly secretHit: boolean;
  readonly instructionHit: boolean;
  readonly sensitiveCategory: SensitiveCategory | undefined;
  readonly shortLivedHit: boolean;
  readonly suppressionHit: boolean;
}

export type EntityType = "self" | "person" | "project" | "org" | "place" | "thing";

export interface AttributeRow {
  readonly id: string;
  readonly name: string;
  readonly entity_type: EntityType | "any";
  readonly cardinality: "one" | "many";
  readonly section_id: string;
  readonly taste_class: number;
  readonly profile_key: number;
  readonly restricted: number;
}

/** Step 6, deterministic part (write-path.md §6.1). */
export interface Resolution {
  /** An existing entity, or a new one to create when something is stored. */
  readonly entity: { readonly id: string; readonly type: EntityType; readonly isNew: false } | { readonly name: string; readonly type: EntityType; readonly isNew: true };
  readonly attribute: AttributeRow | undefined;
  readonly sectionId: string;
  /** The section resolved to People (rule D3, entity typing). */
  readonly isPeopleSection: boolean;
  readonly tasteClass: boolean;
}

/** What the decision table decided (write-path.md §5). */
export type Decision =
  | { readonly row: string; readonly kind: "reject"; readonly reason: ReasonCode }
  | { readonly row: string; readonly kind: "review"; readonly reason: ReasonCode; readonly reviewKind: "instruction" | "sensitive" }
  | { readonly row: string; readonly kind: "active"; readonly reason: ReasonCode; readonly tier: TierNum; readonly preferenceConfirm: boolean }
  | { readonly row: string; readonly kind: "observation"; readonly reason: ReasonCode; readonly floored: boolean }
  | { readonly row: string; readonly kind: "already_stored"; readonly memoryId: string }
  | { readonly row: string; readonly kind: "elicit"; readonly question: string };

/** The result returned to the caller (memory_save output and /v1/writes result). */
export interface WriteOutcome {
  readonly outcome: OutcomeT;
  readonly reason: string;
  readonly message: string;
  readonly id?: string;
  readonly tier?: TierT;
  readonly section?: string;
  readonly memory_status?: "active" | "contested" | "pending_review" | "superseded";
  readonly contested_with?: readonly string[];
  readonly idempotency_key?: string;
  readonly policy_version: string;
}

/** A write-path error, returned as an MCP tool error or an HTTP error (mcp-interface.md §4). */
export type WriteErrorCode = "INVALID_INPUT" | "READ_ONLY_CLIENT" | "REPO_NOT_ENABLED" | "NOT_FOUND" | "RATE_LIMITED" | "STORE_UNAVAILABLE" | "FORBIDDEN";

export class WriteError extends Error {
  readonly code: WriteErrorCode;
  readonly field: string | undefined;
  readonly retryAfterS: number | undefined;

  constructor(code: WriteErrorCode, message: string, field?: string, retryAfterS?: number) {
    super(message);
    this.code = code;
    this.field = field;
    this.retryAfterS = retryAfterS;
  }
}
