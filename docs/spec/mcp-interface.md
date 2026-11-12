# MCP interface and internal API

Status: normative. M1 starts by committing `packages/contracts/src/tools.ts` (zod) and the generated JSON Schemas in `packages/contracts/schema/`. The schemas below are the source; zod definitions MUST produce identical JSON Schema (CI compares).

## 1. Server

| Item | Value |
| --- | --- |
| Endpoint | `POST https://{host}/mcp` (Streamable HTTP). Local mode: `http://127.0.0.1:47821/mcp` |
| SDK | `@modelcontextprotocol/server` 2.x `createMcpHandler`, `legacy: 'stateless'` (answers 2025-era `initialize` without sessions; GET/DELETE return 405) |
| Protocol versions | 2026-07-28 (with `server/discover`), and 2025-11-25, 2025-06-18, 2025-03-26 through the SDK's legacy path |
| Server name | `memory-anywhere`; version = server semver; in `_meta["io.modelcontextprotocol/serverInfo"]` for 2026-07-28 |
| Instructions | memory-policy.md §6.1, in `DiscoverResult.instructions` (2026-07-28) and `InitializeResult.instructions` (2025-era) |
| Capabilities | `tools` only. No resources, prompts, sampling or subscriptions |
| `tools/list` | Deterministic order: `memory_recall`, `memory_profile`, `memory_save`, `memory_forget`, `memory_status`. `ttlMs: 3600000`; `cacheScope: "private"` (the 2026-07-28 values are `public` and `private`; the list differs per grant, since `write = 0` removes tools). The list is filtered per client: if `client_policy.write = 0`, `memory_save` and `memory_forget` are omitted |
| Auth | `Authorization: Bearer` only. Cookies are ignored on `/mcp`. No CORS headers on `/mcp`. A request with an `Origin` header from a browser origin is rejected with 403 |
| Headers checked | The SDK validates `Mcp-Method` and `Mcp-Name` against the body for 2026-07-28 |
| Size limits | Request body ≤ 64 KiB (413 otherwise). Responses: recall ≤ 8,000 chars text, profile ≤ 6,000 |
| Timeouts | Every tool call completes within 10 s server-side or returns `STORE_UNAVAILABLE` (Claude's apps allow 300 s and about 150,000 chars per tool result, so these limits are far inside theirs; [Claude connectors](https://claude.com/docs/connectors/building.md)) |

No `search`/`fetch` compatibility aliases are offered; ChatGPT Developer Mode does not require them ([Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)).

## 2. Common definitions

```json
{
  "$id": "https://memory-anywhere.dev/schema/common.v1.json",
  "$defs": {
    "MemoryId": { "type": "string", "pattern": "^mem_[0-9A-HJKMNP-TV-Z]{26}$" },
    "ObservationId": { "type": "string", "pattern": "^obs_[0-9A-HJKMNP-TV-Z]{26}$" },
    "Kind": { "type": "string", "enum": ["fact", "preference", "instruction", "event"] },
    "Outcome": { "type": "string", "enum": ["active", "observation", "review", "rejected", "queued"] },
    "Tier": { "type": "string", "enum": ["T0", "T1", "T2", "T3"] },
    "PartialDate": { "type": "string", "pattern": "^\\d{4}(-\\d{2}(-\\d{2})?)?$" },
    "Date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "Timestamp": { "type": "string", "format": "date-time" },
    "ErrorCode": {
      "type": "string",
      "enum": ["INVALID_INPUT", "UNAUTHORIZED", "FORBIDDEN", "READ_ONLY_CLIENT", "REPO_NOT_ENABLED", "NOT_FOUND",
               "RATE_LIMITED", "STORE_UNAVAILABLE", "CLIENT_TOO_OLD", "INTERNAL"]
    },
    "Error": {
      "type": "object",
      "required": ["code", "message"],
      "properties": {
        "code": { "$ref": "#/$defs/ErrorCode" },
        "message": { "type": "string", "maxLength": 300 },
        "field": { "type": "string" },
        "retry_after_s": { "type": "integer", "minimum": 1 }
      },
      "additionalProperties": false
    },
    "RecallItem": {
      "type": "object",
      "required": ["id", "kind", "entity", "section", "content", "tier", "status", "via", "recorded_at"],
      "properties": {
        "id": { "$ref": "#/$defs/MemoryId" },
        "kind": { "$ref": "#/$defs/Kind" },
        "entity": { "type": "string" },
        "section": { "type": "string" },
        "attribute": { "type": ["string", "null"] },
        "content": { "type": "string", "maxLength": 400 },
        "valid_from": { "type": ["string", "null"] },
        "valid_to": { "type": ["string", "null"] },
        "recorded_at": { "$ref": "#/$defs/Timestamp" },
        "tier": { "$ref": "#/$defs/Tier" },
        "status": { "type": "string", "enum": ["active", "contested", "superseded"] },
        "contested_with": { "type": "array", "items": { "$ref": "#/$defs/MemoryId" } },
        "via": { "type": "string", "description": "display name of the client of the first source" },
        "expires_at": { "type": ["string", "null"] }
      },
      "additionalProperties": false
    }
  }
}
```

## 3. Tools

Every tool has `title`, `description` (memory-policy.md §6), `inputSchema`, `outputSchema` and `annotations`. Each tool sets `_meta["anthropic/alwaysLoad"] = true` (effect on Claude Code tool search verified in M0 Q07; harmless elsewhere).

Every result carries both `content` (one or more text blocks, starting with the framing line where the tool returns memories) and `structuredContent` matching `outputSchema`. The MCP spec says a tool returning structured content SHOULD also return it serialized in text; this server instead returns a compact human-readable text rendering, which is allowed, and keeps both in sync ([tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

### 3.1 `memory_recall`

Annotations: `{ "title": "Recall memories", "readOnlyHint": true, "openWorldHint": false }`.

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 300 },
    "section": { "type": "string", "maxLength": 32, "description": "Narrow to one section by name, e.g. Preferences" },
    "scope": { "type": "string", "enum": ["any", "global", "repo"], "default": "any" },
    "kinds": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/Kind" }, "maxItems": 4, "uniqueItems": true },
    "as_of": { "$ref": "common.v1.json#/$defs/Date" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 6 }
  },
  "additionalProperties": false
}
```

Output:

```json
{
  "type": "object",
  "required": ["notice", "items", "truncated", "budget_exhausted", "offline"],
  "properties": {
    "notice": { "type": "string" },
    "items": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/RecallItem" }, "maxItems": 12 },
    "truncated": { "type": "boolean" },
    "budget_exhausted": { "type": "boolean" },
    "offline": { "type": "boolean" },
    "generated_at": { "$ref": "common.v1.json#/$defs/Timestamp" }
  },
  "additionalProperties": false
}
```

`scope: "repo"` and `"any"` include repo-scoped memories only for coding callers in an enabled repo (retrieval.md §4).

### 3.2 `memory_profile`

Annotations: `{ "title": "Load profile", "readOnlyHint": true, "openWorldHint": false }`.

Input: `{ "type": "object", "properties": {}, "additionalProperties": false }`.

Output:

```json
{
  "type": "object",
  "required": ["notice", "policy_version", "profile_etag", "text", "sections", "owner_preferences", "pinned", "key_facts", "pending_review_count"],
  "properties": {
    "notice": { "type": "string" },
    "policy_version": { "type": "string" },
    "profile_etag": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "text": { "type": "string", "maxLength": 6000 },
    "sections": { "type": "array", "items": { "type": "string" } },
    "owner_preferences": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/RecallItem" } },
    "pinned": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/RecallItem" } },
    "key_facts": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/RecallItem" } },
    "pending_review_count": { "type": "integer", "minimum": 0 },
    "offline": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

`content[0].text` = `text` (the rendered profile, retrieval.md §7.2).

### 3.3 `memory_save`

Annotations: `{ "title": "Save a memory", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }`. In 2026-07-28, `destructiveHint` defaults to true when `readOnlyHint` is false and `openWorldHint` defaults to true, so both MUST be set explicitly; Claude prompts on every destructive tool ([review criteria](https://claude.com/docs/connectors/building/review-criteria.md)).

```json
{
  "type": "object",
  "required": ["content", "kind", "why_durable"],
  "properties": {
    "content": { "type": "string", "minLength": 1, "maxLength": 400 },
    "kind": { "$ref": "common.v1.json#/$defs/Kind" },
    "why_durable": { "type": "string", "minLength": 1, "maxLength": 200 },
    "user_words": { "type": "string", "maxLength": 200 },
    "explicit_request": { "type": "boolean", "default": false },
    "section": { "type": "string", "maxLength": 32 },
    "entity": { "type": "string", "maxLength": 80, "default": "self" },
    "attribute": { "type": "string", "maxLength": 48 },
    "scope": { "type": "string", "enum": ["global", "repo"], "default": "global" },
    "supersedes": { "$ref": "common.v1.json#/$defs/MemoryId" },
    "change": { "type": "string", "enum": ["update", "correction"], "default": "update" },
    "valid_from": { "$ref": "common.v1.json#/$defs/PartialDate" },
    "expires_on": { "$ref": "common.v1.json#/$defs/Date" },
    "policy_version": { "type": "string", "maxLength": 16 }
  },
  "additionalProperties": false
}
```

- `change` without `supersedes` is ignored.
- `expires_on` is used only with `kind: "event"`.
- `attribute` is a hint; it must name a registry attribute or alias (write-path.md §6.1) or it is ignored.
- `_meta["memory-anywhere/idempotency_key"]` (request `_meta`) is honoured from the stdio proxy only (grants of class `coding`).

Output:

```json
{
  "type": "object",
  "required": ["outcome", "reason", "message", "policy_version"],
  "properties": {
    "outcome": { "$ref": "common.v1.json#/$defs/Outcome" },
    "reason": { "type": "string" },
    "message": { "type": "string", "maxLength": 300 },
    "id": { "oneOf": [ { "$ref": "common.v1.json#/$defs/MemoryId" }, { "$ref": "common.v1.json#/$defs/ObservationId" } ] },
    "tier": { "$ref": "common.v1.json#/$defs/Tier" },
    "section": { "type": "string" },
    "memory_status": { "type": "string", "enum": ["active", "contested", "pending_review", "superseded"] },
    "contested_with": { "type": "array", "items": { "$ref": "common.v1.json#/$defs/MemoryId" } },
    "idempotency_key": { "type": "string" },
    "policy_version": { "type": "string" }
  },
  "additionalProperties": false
}
```

`content[0].text` = `"<outcome>: <message>"`, for example `observation: single mention of a taste; it is saved if it comes up again in another conversation (obs_01JC…)`. Policy outcomes, including `rejected`, are normal results with `isError: false`.

### 3.4 `memory_forget`

Annotations: `{ "title": "Forget a memory", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }`.

```json
{
  "type": "object",
  "required": ["id", "reason"],
  "properties": {
    "id": { "$ref": "common.v1.json#/$defs/MemoryId" },
    "reason": { "type": "string", "minLength": 1, "maxLength": 200 }
  },
  "additionalProperties": false
}
```

Output:

```json
{
  "type": "object",
  "required": ["id", "outcome", "message"],
  "properties": {
    "id": { "$ref": "common.v1.json#/$defs/MemoryId" },
    "outcome": { "type": "string", "enum": ["forgotten", "review", "already_forgotten"] },
    "message": { "type": "string" },
    "undo_until": { "$ref": "common.v1.json#/$defs/Timestamp" }
  },
  "additionalProperties": false
}
```

An id the client could not recall returns `NOT_FOUND` (it does not reveal whether the id exists). Protected memories: write-path.md §9.1.

### 3.5 `memory_status`

Annotations: `{ "title": "Memory status", "readOnlyHint": true, "openWorldHint": false }`.

Input: empty object.

Output:

```json
{
  "type": "object",
  "required": ["store", "health", "client", "policy_version_server", "policy_version_reported", "server_version"],
  "properties": {
    "store": { "type": "string", "enum": ["aws", "local", "offline"] },
    "health": { "type": "string", "enum": ["ok", "degraded", "offline"] },
    "degraded_reasons": { "type": "array", "items": { "type": "string", "enum": ["llm_unavailable", "llm_cap", "backup_lag", "disk_low", "jobs_failing"] } },
    "client": {
      "type": "object",
      "required": ["name", "class", "read", "write"],
      "properties": {
        "name": { "type": "string" },
        "class": { "type": "string", "enum": ["chat", "coding"] },
        "read": { "type": "boolean" },
        "write": { "type": "boolean" },
        "repo_enabled": { "type": ["boolean", "null"] }
      },
      "additionalProperties": false
    },
    "counts_order_of_magnitude": {
      "type": "object",
      "properties": { "memories": { "type": "string", "enum": ["0", "1-9", "10-99", "100-999", "1000+"] } },
      "additionalProperties": false
    },
    "policy_version_server": { "type": "string" },
    "policy_version_reported": { "type": "string" },
    "server_version": { "type": "string" },
    "warnings": { "type": "array", "items": { "type": "string", "maxLength": 200 } },
    "last_contact_at": { "$ref": "common.v1.json#/$defs/Timestamp" },
    "spool_count": { "type": "integer" }
  },
  "additionalProperties": false
}
```

Status never lists sections, projects, entities or exact counts.

## 4. Errors

| Situation | Mechanism |
| --- | --- |
| Malformed JSON-RPC, unknown method, unsupported protocol version | JSON-RPC error (SDK), e.g. `-32022 UnsupportedProtocolVersion` |
| Missing or invalid bearer token | HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="https://{host}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"` |
| Token lacks scope for the tool | Tool result `isError: true`, code `FORBIDDEN` |
| Tool input fails schema | `isError: true`, code `INVALID_INPUT`, `field` set |
| Write on a read-only client | `isError: true`, code `READ_ONLY_CLIENT` |
| Coding caller in a repo not enabled, on a write | `isError: true`, code `REPO_NOT_ENABLED`, message "Run `mema enable` in this repository to use memory here." |
| Quota or rate limit | `isError: true`, code `RATE_LIMITED`, `retry_after_s` |
| Store busy or failing | `isError: true`, code `STORE_UNAVAILABLE` |
| Client older than supported (proxy) | `isError: true`, code `CLIENT_TOO_OLD` |
| Not visible or unknown id | `isError: true`, code `NOT_FOUND` |
| Policy outcome (rejected, review, observation) | Normal result, `isError: false` |

An error result has no `structuredContent` (clients check it against the tool's output schema): the `Error` object is in `_meta["memory-anywhere/error"]`, and `content[0].text` is `"<code>: <message>"` (spec-issues #50).

## 5. Elicitation

Used for the confirmations in write-path.md §5 (rows D5, D7, D15) and write-path.md §9.1. It uses the 2026-07-28 multi-round-trip requests (MRTR) mechanism ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)):

1. **When.** Only if `client_policy.elicitation = 'verified'` **and** the request's `clientCapabilities` declares elicitation. `verified` is set by the owner in the admin UI for a vendor only after M0 Q09 shows the vendor's app renders the question to the human and returns the human's answer (not a model-generated one). Default `'none'` for all vendors. 2025-era protocol versions never get elicitation.
2. **Question.** A yes/no question whose text quotes the first 200 characters of `content` (escaped as in retrieval.md §9) and names the category or slot, for example `Apply this preference in all your AI apps: “Prefers short answers to quick questions”?`. The human never approves blind.
3. **Result.** The tool returns an `InputRequiredResult` with the question and a `requestState`. The server stores a `pending_elicitation` row (data-model.md §2) holding the grant, tool, the sha256 of the canonical call arguments, the rendered question and a 5-minute expiry.
4. **`requestState`** = base64url of AES-256-GCM (key `meta.mrtr_key`, random 96-bit nonce) over `{"v":1,"grant_id":…,"pending_id":…,"args_sha256":…,"exp":<unix seconds>}`. It is opaque to the client and integrity-protected.
5. **Retry.** The client retries the original call with `inputResponses` and the `requestState`. The server decrypts and checks: tag valid; `grant_id` equals the caller's grant; `args_sha256` equals the retried arguments' digest; not expired; the `pending_elicitation` row exists and `consumed_at` is NULL. It then sets `consumed_at` (single use) and continues the decision table with the answer. Any failed check → the table's "else" branch, as if no elicitation were possible; the attempt is audited.
6. **Idempotency.** An `input_required` result is never written to `write_request` (write-path.md §2.3).
7. If the client does not answer within 5 minutes, the pending row expires and a later retry takes the "else" branch.

## 6. Authorization of calls

| Scope | Grants |
| --- | --- |
| `memory.read` | `memory_recall`, `memory_profile`, `memory_status`; `/v1/recall`, `/v1/status` |
| `memory.write` | `memory_save`, `memory_forget`; `/v1/writes` ops `save`, `forget` |
| `memory.capture` | `/v1/session-start`, `/v1/projection`, `/v1/writes` op `prompt` |
| `memory.admin` | `/v1/admin/*` except `stepup`. Never granted through OAuth consent; only via step-up tokens (auth-and-security.md §6) |

`/v1/import/estimate` needs only `memory.read` and returns no content.

| Grant type | Scopes |
| --- | --- |
| Chat vendor (read-write) | `memory.read memory.write` |
| Chat vendor (read-only fallback, e.g. ChatGPT if Plus cannot write) | `memory.read` |
| PC grant (`memory-anywhere` CLI client) | `memory.read memory.write memory.capture` |
| Step-up token | `memory.admin` for one command id |

Calls with class `coding` (PC grant) are additionally limited by `MA-Repo-Key`: reads in a repo that is not enabled return only the profile-free one-line notice for session-start and an empty recall with notice "memory-anywhere is not enabled for this repository."; writes return `REPO_NOT_ENABLED`. `mema search` from a terminal computes the repo key of its working directory like the proxy and is subject to the same rule, so a shell in a repo that is not enabled gets nothing.

## 7. Internal API (`/v1`)

JSON over HTTPS, `Authorization: Bearer`, `Content-Type: application/json`, request body ≤ 1 MiB. Every request carries `MA-Client-Version`; unsupported versions get 426 (topology-and-ipc.md §11). Errors use HTTP status plus the `Error` object as the body. Schemas live in `packages/contracts/schema/v1/*.json`.

| Method and path | Scope | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/health` | none | — | `{ok: bool, version, schema_version: int, policy_version, min_client_version}` |
| `POST /v1/session-start` | capture | `{tool: "claude-code"\|"codex"\|"cursor", repo_key: string\|"none", session_id: string, max_chars: int}` | `{context: string, profile_etag, profile: string, repo_enabled: bool, capture_enabled: bool, policy_version, notices: string[]}`; `profile` refreshes the client's offline `profile.md` (spec-issues #30) |
| `GET /v1/projection?repo_key=&etag=` | capture | — | 304, or `{profile: string, repo_context: string\|null, etag, generated_at}` |
| `POST /v1/writes` | capture or write per op | `{entries: Entry[1..100], dry_run?: bool}` | `{results: [{idempotency_key, outcome, reason, id?}]}` |
| `POST /v1/recall` | read | memory_recall input + `repo_key` | memory_recall output |
| `GET /v1/status` | read | — | memory_status output |
| `POST /v1/repos/check` | capture | `{repo_key}` | `{enabled: bool, capture: bool, project: string\|null}` |
| `POST /v1/import/estimate` | read | `{source_type, file_sha256, turns, chars, item_count, since?, until?}` (counts only) | `{estimate_usd, input_tokens, output_tokens, cache_hits, import_budget_remaining_usd}` |
| `POST /v1/admin/stepup` | write (PC grant only) | `{command: AdminCommand, args: object}`; `args` is the command's canonical arguments (≤ 4 KiB, schema per command in `packages/contracts/schema/v1/admin/`). There is no client-written summary: the approval page shows text the server renders from `args` (auth-and-security.md §6.2) | `{request_id, user_code, approve_url, expires_in: 300}` |
| `GET /v1/admin/stepup/{request_id}` | write (same grant) | — | `{status: "pending"\|"approved"\|"denied"\|"expired", token?: string, token_expires_in?: 600 (3,600 for import), import_batch_id?: string}` |
| `POST /v1/admin/{command}` | admin (step-up token for that command; the body must hash to the approved `args`, except `import`, whose batches must carry the approved `batch_id`) | command-specific (config-and-cli.md §4.2) | command-specific |

`Entry`:

```json
{
  "type": "object",
  "required": ["idempotency_key", "op", "observed_at", "payload"],
  "properties": {
    "idempotency_key": { "type": "string", "pattern": "^(spl|pxs)_[0-9A-HJKMNP-TV-Z]{26}$" },
    "op": { "type": "string", "enum": ["prompt", "save", "forget"] },
    "observed_at": { "type": "string", "format": "date-time" },
    "tool": { "type": "string", "enum": ["claude-code", "codex", "cursor"] },
    "repo_key": { "type": "string" },
    "session_id": { "type": "string", "maxLength": 128 },
    "payload": { "type": "object" }
  },
  "additionalProperties": false
}
```

- `op: prompt` payload `{prompt: string ≤ 8000}`; requires `memory.capture`; only for enabled repos (others are acknowledged with outcome `rejected`, reason `repo_not_enabled`, and discarded).
- `op: save` payload = `memory_save` input without `supersedes`/`change`; requires `memory.write`.
- `op: forget` payload `{id, reason}`; requires `memory.write`; never accepted from spooled entries (the client never spools forgets; the server rejects `forget` entries whose `observed_at` is more than 60 s before receipt).
- The server ignores any tier, source, client or channel field in a payload.

`AdminCommand` enum: `repo-enable`, `repo-disable`, `project-track`, `project-add`, `export`, `import`, `review`. Every other owner action (save, edit, pin, list, history, forget, bulk forget, undo, purge, revert, sections, attributes, client grants, policy) is in the admin UI only, behind the admin session and its step-up rules (auth-and-security.md §3.4). In local mode the same commands call `/v1/admin/*` with the local token.
