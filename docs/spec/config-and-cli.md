# Configuration and CLI

Status: normative.

## 1. Packages and binaries

| Artifact | Contents | Native modules | Distribution |
| --- | --- | --- | --- |
| npm `memory-anywhere` | Client: stdio proxy, hooks, CLI, spool, token cache, deploy commands (CDK app bundled). The deploy subcommands are built first, in M0; the rest in M1 | none | npm (trusted publishing, provenance); bins `memory-anywhere` and `mema` |
| `memory-anywhere-server` | Server: MCP, `/v1`, OAuth, admin UI, write path, retrieval, embeddings, jobs | `better-sqlite3`, `onnxruntime-node` | GitHub release tarballs per platform (`linux-arm64`, `linux-x64`, `win32-x64`, `darwin-arm64`) with `node_modules` included; npm package of the same name in M5 if the name is free then, else tarballs only |
| Plugins | `plugins/claude-code`, `plugins/codex`, `plugins/cursor`, each bundling `dist/memory-anywhere.mjs` (esbuild bundle of the client) | none | GitHub repo marketplace manifests pinned to tag + SHA |

Workspace packages (private, never published): `@memory-anywhere/contracts` (schemas, normalization, redaction, reasons; shared), `@memory-anywhere/client`, `@memory-anywhere/server`, `@memory-anywhere/importers`, `@memory-anywhere/evals`, `@memory-anywhere/deploy-aws`.

onnxruntime-node ships no darwin-x64 binary, so local mode on Intel Macs is unsupported in v1 ([review2-factcheck row 25](../../review2-factcheck-build.md)). A Node SEA single-file binary is out of scope for v1 (ADR-0006).

## 2. Toolchain

| Item | Version |
| --- | --- |
| Node | 24.x LTS; `engines: ">=22.12"`; CI also runs 26.x |
| pnpm | 10 or later, pinned in root `packageManager` |
| TypeScript | strict, `module: NodeNext`, `types: ["node"]` |
| Pinned runtime deps (exact, verified at M0 start) | `@modelcontextprotocol/server` 2.x, `@modelcontextprotocol/node` 2.x, `zod` 4.x, `better-sqlite3` 13.x, `onnxruntime-node` 1.31.x, `@huggingface/tokenizers` 0.2.x, `ulid`, `chrono-node` 2.x, `smol-toml`, `age-encryption` 0.3.x, `oidc-provider` ~9.13, `@simplewebauthn/server`, `argon2` (server only), `eta` |
| Dev | `vitest`, `fast-check`, `tsx`, `esbuild`, `aws-cdk-lib` |
| pnpm `onlyBuiltDependencies` | `["better-sqlite3", "onnxruntime-node", "argon2"]` |

M0 Q22 checks whether `node:sqlite` on Node 24 provides FTS5 and WAL; if it does, ADR-0006 may replace `better-sqlite3`. M0 Q14 checks that `onnxruntime-node` loads with lifecycle scripts disabled (its binaries are in the tarball).

## 3. Paths

One source: `packages/contracts/src/paths.ts`. Never build paths from `%USERPROFILE%\Documents` (OneDrive redirection). All paths must work with spaces.

| OS | Client data `{data}` | Client config | Local-mode server data | Local-mode server config |
| --- | --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\memory-anywhere\` | `%APPDATA%\memory-anywhere\client.toml` | `%LOCALAPPDATA%\memory-anywhere\server\` | `%APPDATA%\memory-anywhere\server.toml` |
| macOS | `~/Library/Application Support/memory-anywhere/` | same dir, `client.toml` | `…/memory-anywhere/server/` | same dir, `server.toml` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/memory-anywhere/` | `${XDG_CONFIG_HOME:-~/.config}/memory-anywhere/client.toml` | `{data}/server/` | `${XDG_CONFIG_HOME:-~/.config}/memory-anywhere/server.toml` |
| AWS instance | n/a | n/a | `/var/lib/memory-anywhere/` | `/etc/memory-anywhere/server.toml` |

`MA_HOME` replaces both the data and config roots (tests use it). Inside `{data}`: `tokens.json`, `tokens.lock`, `local.token` (local mode), `spool\`, `cache\`, `logs\`, `models\` (local mode only). Directory ACLs are user-only on creation (Windows: `icacls <dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`; POSIX: 0700).

## 4. CLI

`mema` and `memory-anywhere` are the same binary. Global flags: `--json` (machine output), `--config <file>`, `--verbose`. Exit codes: 0 ok; 1 usage error; 2 store unavailable; 3 validation or policy rejection; 4 conflict; 5 step-up denied, expired or not approved; 6 doctor found a failing check.

### 4.1 Client commands (PC grant)

| Command | Flags | Does |
| --- | --- | --- |
| `mema init` | `--clients <list>` (default: all detected of `claude-code,codex,cursor`), `--dry-run`, `--local`, `--from-workspace <path>`, `--upgrade` (local mode: replace the server build and run `migrate`), `--schedule-sync`, `--print-custom-instruction`, `--claude-ai-skill` | clients.md §6. `--local` sets up local mode: with `--from-workspace <path>` it runs the server built in that repository checkout (`pnpm build` output; used in M1, before release tarballs exist), otherwise it installs the server release tarball; then it downloads the model and starts the server. `--claude-ai-skill` writes `memory-anywhere-skill.zip` and prints upload steps (claude.ai skills need code execution on and are uploaded by hand; [claude.ai skills](https://support.claude.com/en/articles/12512180)) |
| `mema connect <url>` | | Sets `store.url`, checks `/v1/health` |
| `mema login` | `--no-browser` | PC grant (auth-and-security.md §5.6) |
| `mema logout` | | Revokes and deletes the PC grant |
| `mema status` | | Calls `/v1/status`; prints store, health, policy version, spool count |
| `mema doctor` | `--policy`, `--fix` (applies safe fixes: regenerate caches, reinstall hooks) | clients.md §6 |
| `mema sync` | `--quiet` | Drains spool; refreshes profile and repo caches for every enabled repo seen on this PC |
| `mema search <query>` | `--section <name>`, `--limit <1..10>` | Recall from the terminal; same repo-enablement rule and read budget as the proxy (mcp-interface.md §6) |
| `mema ui` | | Opens the admin UI in the browser (aws mode: `https://admin.{host}`; local mode: a one-time login link to `http://127.0.0.1:47821/admin/`) |
| `mema mcp` | `--tool <claude-code\|codex\|cursor\|generic>` | stdio proxy |
| `mema hook <tool> <event>` | | Hook entrypoint; events `session-start`, `prompt` |
| `mema import <file> --dry-run` | `--source <id>`, `--since`, `--until` | Parses and redacts on the PC, then calls `/v1/import/estimate` with counts only; prints counts and the cost estimate; no step-up (write-path.md §10.5) |
| `mema version` | | Client version, policy version, server version |

### 4.2 Admin commands (step-up per call)

The CLI has exactly these seven admin commands. Every other owner action (save, edit, pin, list, history, forget, bulk forget, undo, purge, revert, sections, attributes, client grants and revocation, policy, export recipients) is done in the admin UI (auth-and-security.md §8.1), which already holds a passkey session. Each command id below is the `AdminCommand` value sent to `/v1/admin/stepup` (mcp-interface.md §7); the approval page renders its arguments as listed in auth-and-security.md §6.2.

| Command | AdminCommand | Flags | Does |
| --- | --- | --- | --- |
| `mema enable` | `repo-enable` | `--capture` / `--no-capture` (default no capture), `--track` / `--no-track` | Enables the current repo; registration prompt (memory-policy.md §10) |
| `mema disable` | `repo-disable` | | Disables the current repo |
| `mema project track` | `project-track` | `--name <n>`, `--repo-url <u>` | Creates the approved project entity for the current repo |
| `mema project add <name>` | `project-add` | `--alias <a>` (repeatable), `--status <idea\|active\|paused\|shipped\|archived>`, `--goal "<text>"` | Creates an approved project with no repository |
| `mema review` | `review` | `--approve <id>…`, `--reject <id>…` (no flags: lists pending item ids, kinds and ages only, with the PC grant and no step-up; content is shown only on the approval page and in the admin UI) | Resolves review items, including `preference_confirm` and `project_proposal` |
| `mema export` | `export` | `--out <file>` (required), `--section projects --format json`, `--include-auth`, `--recipient <age1…>` (default: the registered recipient; an unregistered one needs a second confirmation on the approval page) | data-model.md §10 |
| `mema import <file> --commit` | `import` | `--source <id>` (importers.md), `--since`, `--until`, `--resume <batch_id>` | write-path.md §10.5 |

### 4.3 Deploy and operator commands

| Command | Where | Flags | Profile |
| --- | --- | --- | --- |
| `mema deploy aws` | PC | `--stage <prod\|eval-<id>\|spike>`, `--region`, `--profile` (default `memory-anywhere-deploy`), `--update`, `--release <version>`, `--release-file <tarball>` (non-prod only, dev-signed), `--yes` (non-prod only), `--dns manual|route53` (default `manual`: prints the records to add and waits for them), `--hosted-zone-id <id>` (route53 only). Host from `MA_DOMAIN`. Runs `aws sso logout` on exit for `prod`; keeps the sign-in for non-prod stages (spec-issues.md #11) | deploy |
| `mema destroy aws` | PC | `--stage` (required) | deploy |
| `./ma-operator.sh setup-link \| set-llm-key \| restore \| reset-owner [--cancel] \| acme-account \| import-export \| delete-data` | AWS CloudShell only | per deployment-aws.md §3.2 | operator Identity Center user |

The one-time bootstrap (`deploy/aws/bootstrap-member.sh` in the member account, then `deploy/aws/bootstrap-identity.sh` in the management account) also runs in CloudShell (deployment-aws.md §3.3).

### 4.4 Server commands (`memory-anywhere-server`)

| Command | Flags | Does |
| --- | --- | --- |
| `start` | `--config <file>`, `--local`, `--port <n>` (default 47821), `--ephemeral` (data in a temp dir, deleted at exit) | Runs the server |
| `init` | `--config` | Creates the DB (migration 0001 + seeds), generates `meta` keys, pre-registers the `memory-anywhere-cli` OAuth client, downloads and verifies the embedding model |
| `migrate` | `--dry-run` | Applies pending migrations (operations.md §6) |
| `dump --canonical` | `--out`, `--content` (content hash scope) | data-model.md §12 |
| `backup --out <file>` | | SQLite online backup |
| `reset-owner` | `--schedule`, `--cancel` | auth-and-security.md §3.3 break-glass (24-hour delay) |
| `setup-token` | `--renew` | Issues a fresh 30-minute setup token; only with no owner or after an executed reset (auth-and-security.md §3.1) |
| `maint` | `--compact` | Offline compaction for `ma-maint`: checkpoint, `VACUUM INTO`, zero and replace the old files (deployment-aws.md §4); refuses to run while the server is up |
| `import-export` | `--prepare`, `--in <file>`, `--include-auth` | Imports a full export (deployment-aws.md §5.6) |
| `version` | | Server, schema and policy versions |

### 4.5 Eval commands (repo only, not shipped)

`pnpm eval run --suite <W|R|A|X|S|C|P|I> --system <name> --dataset <dir> --split <dev|test> --runs <n> --out <file>`, `pnpm eval calibrate <dup|abstain|support|capture_support>` (section threshold calibration runs after M3, write-path.md §12), `pnpm eval report --in <dir>`. evals.md §9.

## 5. Server config (`server.toml`)

Validated at start against a zod schema in `packages/server/src/config/schema.ts`. An invalid value or **unknown key** stops the server with `file:line key: message`. `memory-anywhere-server start --print-config` prints the effective config with secrets masked.

```toml
schema = 1

[server]
mode = "aws"                     # aws | local
public_url = "https://m-x7k2q9.example.com"   # {host}; empty in local mode
listen = "unix:/run/memory-anywhere/http.sock" # local: "127.0.0.1:47821"
data_dir = "/var/lib/memory-anywhere"

[owner]
timezone = "America/Chicago"     # IANA; used by the time parser and job schedules

[embedding]
model = ""                       # "<hf repo>@<revision sha>", set from ADR-0005
dtype = "q8"                     # q8 | q4 | fp32

[llm]
provider = "anthropic"           # anthropic | openai | none   (local default: none)
model = ""                       # pinned dated model id from ADR-0007
judge = false
daily_usd_cap = 1.00
import_usd_cap = 20.00

[write]
support_min = 0.5                # initial; calibrated M2
capture_support_min = 0.6        # initial; calibrated M3
event_default_ttl_days = 30
event_max_ttl_days = 90          # clamp for model-supplied expires_on (write-path.md D13)

[observation]
ttl_days = 60
promote_min_sessions = 2
chat_session_gap_hours = 6
max_open_per_client = 500

[sections]
max_active = 16
max_new_per_run = 2
min_members = 3

[recall]
default_limit = 6
max_limit = 10
max_chars = 8000
profile_max_chars = 6000

[client_defaults.chat]
quota_saves_per_hour = 20
quota_forgets_per_day = 5
read_budget_1h = 20
read_budget_24h = 60

[client_defaults.coding]
quota_saves_per_hour = 40
quota_forgets_per_day = 5
read_budget_1h = 60
read_budget_24h = 200

[sensitive]
blocked = ["health", "finances", "religion", "politics", "sexual_life", "immigration", "criminal", "home_address"]
llm_check = true

[retention]
forgotten_purge_days = 30
extraction_cache_days = 30
resolved_review_days = 30
audit_days = 90
write_request_days = 180
session_prompt_hours = 24
pre_copy_hours = 24              # pre-update, pre-migration and pre-restore DB copies (deployment-aws.md §7.3)

[deployment]                      # aws mode only
doh_url = "https://cloudflare-dns.com/dns-query"   # DNS-over-HTTPS resolver for the hourly DNS check (deployment-aws.md §7.3)

[rate_limits]                     # operations.md §3
token_per_ip_per_min = 10
register_per_ip_per_min = 10
authorize_per_ip_per_min = 20
login_per_ip_per_min = 5
recover_per_ip_per_hour = 5
mcp_per_grant_per_min = 120
unauth_per_ip_per_min = 30

[alerts]
sns_topic_arn = ""               # aws mode; empty in local mode (admin UI banner only)
digest_hour_local = 8

```

Calibrated thresholds (`dup_threshold`, `abstain_cosine`, `sections_cluster_threshold`) live in `meta`, not in this file (write-path.md §12).

## 6. Client config (`client.toml`)

Validated at start; unknown keys produce a warning (the client must keep working when a newer version's keys are present).

```toml
schema = 1

[store]
mode = "remote"                  # remote | local
url = "https://m-x7k2q9.example.com"

[repos]
deny_remotes = []                # hosts or host/path prefixes, e.g. an employer's Git host

[network]
session_start_timeout_ms = 1500
save_timeout_ms = 8000
call_timeout_ms = 5000

[spool]
max_bytes = 10485760
max_age_days = 30

[log]
level = "info"                   # error | warn | info | debug (debug never logs prompt text)
```

## 7. Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `MA_HOME` | client, local server | Root for data and config |
| `MA_LLM_API_KEY` | local server | LLM key in local mode |
| `MA_STORE_URL` | client | Overrides `store.url` (evals) |
| `MA_TOKEN_FILE` | client | Overrides the token file path (evals) |
| `MA_NO_BROWSER` | client | Never open a browser |
| `MA_DOMAIN` | `mema deploy aws`, `mema destroy aws`, `mema doctor` | **Required from M0.** The subdomain used as `{host}` (for example `memory.example.com`), in a DNS zone the owner controls. Also read from `%APPDATA%\memory-anywhere\deploy.toml`. Owner-specific: never committed to any repository (deployment-aws.md §6.1). Deploy commands refuse to run without it |
| `MA_EVAL_ANTHROPIC_API_KEY`, `MA_EVAL_OPENAI_API_KEY`, `MA_EVAL_GOOGLE_API_KEY` | `packages/evals` only | **Optional.** The owner's personal API keys for cross-vendor dataset generation, labelling and API-driven eval runs (evals.md §4, §8.2). Absent keys disable those runs; every milestone gate can pass without them |
| `MA_EVAL_USD_CAP` | `packages/evals` only | Hard spend cap across all eval API calls, in USD. Default and maximum `30`; separate from the `$20` import budget. The harness tracks estimated spend in `docs/results/eval-spend.json` and stops before exceeding it |
