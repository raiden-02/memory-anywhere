# Operations

Status: normative.

## 1. Logging

- Server logs are JSON lines to stdout (journald; shipped to CloudWatch in aws mode, 30-day retention). Fields: `ts`, `level`, `req_id`, `route` (or tool name), `client_id`, `op`, `outcome`, `reason`, `status`, `latency_ms`, `ip_prefix`, `error_code`.
- Logs never contain memory content, queries, prompts, `user_words`, tokens, cookies, client secrets or request bodies. A unit test feeds canary strings through every route and fails if any canary appears in captured logs.
- 4xx responses on unauthenticated routes are logged at a sampled rate: the first 10 per IP per minute, then 1 in 100.
- There is no plaintext debug logging mode in v1. Debugging uses ids, reason codes and the admin UI, which shows content to the owner directly.
- Client logs: `{data}\logs\client.log` and `hooks.log`, rotated at 1 MB, 5 files, no prompt or memory text.

## 2. Alerts

Delivered to: the admin UI banner and alert list (always); SNS email (aws mode, immediate alerts only; the server writes `alert-<id>.json` with the alert id and counts only to the outbox, which publishes it, deployment-aws.md §4); the daily digest (aws mode email at `digest_hour_local`, and the admin UI). `memory_status.warnings` lists open alerts relevant to that client.

| Alert id | Trigger | Delivery |
| --- | --- | --- |
| `grant_created` | Any new OAuth grant or static bearer | immediate + digest |
| `pairing_race` | A second registration hit an open pairing window, or a registration did not match the window's vendor (auth-and-security.md §4.1) | immediate |
| `owner_reset_requested` | An owner reset was scheduled (24-hour delay, auth-and-security.md §3.3) | immediate, repeated every 6 hours until it executes or is cancelled |
| `restored` | The server started in restored state (deployment-aws.md §5.5) | immediate |
| `store_imported` | A full export was imported (deployment-aws.md §5.6) | immediate |
| `dns_mismatch` | The updater's hourly check finds `{host}` or `admin.{host}` not resolving to the instance's Elastic IP (for example a proxied Cloudflare record or a changed record) | immediate |
| `stepup_unexpected` | 3 denied or expired step-up requests in 1 hour | immediate |
| `refresh_reuse` | Refresh token reuse outside the grace window | immediate |
| `auth_fail` | 5 failed owner logins or recovery attempts in 10 minutes | immediate |
| `passkey_clone` | Sign-count decrease | immediate |
| `save_quota` | A client exceeds its hourly save quota | digest |
| `forget_quota` | A client exceeds its daily forget quota | immediate |
| `read_budget` | A client passes 80% of its 24 h read budget | digest; immediate at 100% |
| `supersede_remote` | A non-T0 save superseded or contested a memory | digest |
| `backup_lag` | Litestream replica lag > 60 s for 5 minutes (metric filter on Litestream logs) | immediate |
| `disk_low` | Free disk < 20% | immediate |
| `llm_cap` | Daily LLM cap reached | digest |
| `job_failed` | A job reaches `dropped` | digest |
| `recovery_used` | A recovery code was used (auth-and-security.md §3.3; spec-issues #64) | digest |
| `update_failed` | Updater rolled back | immediate |
| `manifest_mismatch` | From M4: daily manifest check finds a chain break | immediate |
| `kms_or_bucket_change` | CloudTrail EventBridge rules (deployment-aws.md §2) | immediate (SNS directly) |
| `cost` | Budgets alarm | immediate (SNS directly) |

## 3. Rate limits and quotas

All limits are enforced in the server process (in-memory token buckets keyed by IP prefix or grant). Caddy is a plain reverse proxy; stock Caddy has no rate-limit handler.

| Route or action | Key | Limit |
| --- | --- | --- |
| `/oauth/token` | IP | 10/min |
| `/oauth/reg` | IP | 10/min (and only inside a pairing window) |
| `/oauth/auth`, `/oauth/auth/:uid`, `/pair/*`, `/consent/*` | IP | 20/min |
| Admin login (WebAuthn assertion) | IP | 5/min |
| `/recover` | IP | 5/hour; 10/day global |
| `/mcp`, `/v1/*` | grant | 120/min |
| Any unauthenticated request (before token check) | IP | 30/min |
| `memory_save` (+ `/v1/writes` save) | client | `quota_saves_per_hour` (chat 20, coding 40) |
| `memory_forget` | client | `quota_forgets_per_day` (5) |
| Prompt intake (`/v1/writes` op prompt) | client | 600/hour |
| Recall | client | read budgets (retrieval.md §5) and 60 calls/hour |
| Request body | all | `/mcp` 64 KiB, `/v1` 1 MiB |

Over a limit: HTTP 429 with `Retry-After`, or tool error `RATE_LIMITED` with `retry_after_s`. Unauthenticated requests are rejected before any database or model work. The instance uses standard CPU credits, so floods throttle rather than bill.

## 4. Jobs

One worker loop in the server process polls `job` every 1 s (`status = queued AND next_at <= now`), runs one job at a time, and backs off 1 min, 10 min, 60 min on failure, then `dropped`.

| Job | Schedule | Does |
| --- | --- | --- |
| `extract` | on capture batch flush; import | write-path.md §10 |
| `reslot` | after an LLM-less free-text save | write-path.md §6.2 |
| `embed` | after write if inline embedding failed | embedding |
| `reembed` | on model change | data-model.md §8 |
| `section_cluster` | weekly Sun 03:00 owner time | memory-policy.md §9.2 |
| `expire` | hourly | observations past `expires_at` → expired; events past `expires_at` listed in stale report |
| `purge` | hourly | data-model.md §9 for `purge_after` passed |
| `prune` | hourly | `session_prompt` past 24 h; `read_ledger` past 48 h; `write_request` past 180 d; `extraction_cache` past 30 d; resolved `review_item` payloads past 30 d; `audit` past 90 d; unused clients past 24 h; expired step-up (their `args_json` 24 h after expiry), pairing, pending-elicitation and setup rows |
| `digest` | daily at `digest_hour_local` | alert digest; stale-events report; bad-save rate per client |
| `vacuum` | local mode: weekly Sun 04:00 owner time; aws mode: inside `ma-maint`, which runs weekly and on nights after a purge (deployment-aws.md §4) | `VACUUM` (local) / `VACUUM INTO` with zeroing of the old files (aws) |
| `manifest` | from M4, daily 04:30 UTC | deployment-aws.md §5.4 |
| `hmac_rotate` | every 90 days | new `audit_hmac_key`; old key discarded (old audit rows stay unlinkable) |

## 5. Metrics and health

- `GET /v1/health` (public): `{ok, version, schema_version, policy_version, min_client_version}`. `ok` is false when the DB is not writable or the embedding model is not loaded.
- Admin UI health page: request counts by status, p50/p95 latency per route, saves by outcome, Litestream lag, disk, job queue, LLM spend, per-client activity.
- CloudWatch: 3 metric filters (§2 of deployment-aws.md), EC2 status checks. No other custom metrics.

## 6. Schema migrations

- Forward-only numbered SQL files `packages/server/migrations/NNNN_<name>.sql`, plus optional `NNNN_<name>.ts` for data migrations, applied in order inside one transaction each.
- `meta.schema_version` is the number of the last applied migration.
- The server refuses to start when `schema_version` is newer than the newest migration it knows, or older (it tells the operator to run `migrate`).
- `memory-anywhere-server migrate` takes an online backup first (`pre-migrate-<n>.db`), which the updater deletes after 24 hours of healthy operation (deployment-aws.md §7.3); in local mode the server deletes it after 24 hours.
- Every migration has a test that applies it to the previous release's fixture store (`packages/server/test/fixtures/store-v<N>.db`) and checks the content hash of untouched tables is unchanged and the migration's own assertions hold.
- Embedding model changes are migrations of data, not schema (`reembed` job).

## 7. Upgrades

- Server: deployment-aws.md §7.3 (aws); `mema init --local --upgrade` (local).
- Client: `npm i -g memory-anywhere@<ver>`; plugins update through their marketplace (auto-update off; the owner updates). Version skew: topology-and-ipc.md §11.
- Policy versions ship with server releases. Activating one (admin UI) changes `tools/list`, which clients pick up per `ttlMs` or a manual refresh (clients.md §4.3).

## 8. Error handling

| Failure | Behaviour |
| --- | --- |
| SQLite busy beyond retries | Tool error `STORE_UNAVAILABLE`; `/v1` 503 with `Retry-After: 2` |
| Embedding model fails at runtime | Saves still commit; embedding queued as job `embed`; recall uses FTS only and sets `health = degraded` |
| LLM unavailable or capped | write-path.md §6.2 fallbacks; `degraded_reasons` includes `llm_unavailable` or `llm_cap` |
| Litestream down | Writes continue; alert `backup_lag` |
| Disk full | Writes return `STORE_UNAVAILABLE`; alert `disk_low` fires before (20%) |
| Unhandled exception in a request | 500 / `INTERNAL`; logged with `req_id`; never includes content |
| Server unreachable from the PC | topology-and-ipc.md §5 offline behaviour; spool |

## 9. Testing strategy (beyond evals)

| Kind | What | Where |
| --- | --- | --- |
| Unit, table-driven | Every decision row D1–D19 and store rule 0–7; every screen with positive and negative fixtures; normalization; redaction; repo key; rendering and escaping | `packages/*/test` |
| Property (fast-check, ≥ 1,000 runs) | write-path.md §14; export→import identity (content hash, data-model.md §12); migration on previous fixtures; spool replay idempotence | same |
| Contract | zod ↔ JSON Schema equality; generated policy files equal committed; size budgets (memory-policy.md §5); route inventory | CI |
| Golden fixtures | Hook payloads per client version recorded in M0 (`evals/fixtures/hooks/<tool>/<version>/`); importer sample files | CI |
| OAuth conformance | m0-spike.md §5 conformance list and evals.md suite S family S-OAUTH | CI (local issuer) and M2 gate (deployed) |
| Fault injection | Kill the server during spool drain (write-path.md §14); kill during migration (restore from pre-migrate backup) | CI nightly |
| Windows | Full unit, property and contract suites on `windows-latest` with a workspace path containing a space and a `MA_HOME` under a path with a space | CI |
| Fresh install | Clean Windows, macOS and Linux VMs: `npm i -g memory-anywhere`, `mema init` against an eval stack, < 10 minutes to a working Claude Code session | M5 gate |

## 10. CI

`.github/workflows/ci.yml` matrix: `windows-latest` (x64), `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64), `macos-latest` (arm64). Steps: `pnpm install --frozen-lockfile`; typecheck; lint; unit, property and contract tests; embed smoke test (model from cache, one query); `claude plugin validate --strict` on `plugins/claude-code` (Linux only). Nightly: fault injection, suites W and R on the test split.
