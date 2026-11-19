# Configuration and CLI

Status: normative.

## 1. Packages and binaries

| Artifact | Contents | Native modules | Distribution |
| --- | --- | --- | --- |
| npm `memory-anywhere` | Client: stdio proxy, hooks, CLI, spool, token cache, deploy commands (CDK app bundled; `aws-cdk-lib`, `constructs` and the CDK CLI are plain dependencies, since `aws-cdk-lib` loads files from its own folder; an install runs the CDK in `{config}/cdk/`, which holds its `cdk.json` and AMI pins, where a checkout uses `deploy/aws/` and commits them) | none | npm (trusted publishing, provenance); bins `memory-anywhere` and `mema` |
| `memory-anywhere-server` | Server: MCP, `/v1`, OAuth, admin UI, write path, retrieval, embeddings, jobs | `onnxruntime-node` (SQLite is the built-in `node:sqlite`, ADR-0006) | GitHub release tarballs per platform (`linux-arm64`, `linux-x64`, `win32-x64`, `darwin-arm64`) with `node_modules` included; an npm package of the same name is planned if the name is free, else tarballs only |
| Plugins | `plugins/claude-code`, `plugins/codex`, `plugins/cursor`, each bundling `dist/memory-anywhere.mjs` (esbuild bundle of the client) | none | GitHub repo marketplace manifests pinned to tag + SHA |

Workspace packages (private, never published): `@memory-anywhere/contracts` (schemas, normalization, redaction, reasons; shared), `@memory-anywhere/client`, `@memory-anywhere/server`, `@memory-anywhere/importers`, `@memory-anywhere/evals`, `@memory-anywhere/deploy-aws`.

onnxruntime-node ships no darwin-x64 binary, so local mode on Intel Macs is unsupported in v1. A Node SEA single-file binary is out of scope for v1 (ADR-0006).

## 2. Toolchain

| Item | Version |
| --- | --- |
| Node | 24.x LTS; `engines: ">=24"`; CI also runs 26.x |
| pnpm | 10 or later, pinned in root `packageManager` |
| TypeScript | strict, `module: NodeNext`, `types: ["node"]` |
| Pinned runtime deps (exact, in each `package.json`) | `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `@modelcontextprotocol/client` 2.4.0 (the stdio proxy's link to `/mcp`), `zod` 4.6.7, `onnxruntime-node` 1.31.1, `@huggingface/tokenizers` 0.2.0, `ulid` 3.x, `chrono-node` 2.x, `smol-toml` 1.x, `yaml` 2.x (policy lexicon files), `age-encryption` 0.3.x, `oidc-provider` 9.13.3, `@simplewebauthn/server`, `argon2` (server only), `eta`. SQLite is Node's built-in `node:sqlite` (ADR-0006); `better-sqlite3` is not used |
| Dev | `vitest`, `fast-check`, `tsx`, `esbuild`, `aws-cdk-lib` |
| pnpm `allowBuilds` (pnpm 12) | `argon2: true`, `onnxruntime-node: false` (its binaries ship in the package, ADR-0005) |

`node:sqlite` on Node 24 provides FTS5, WAL and every PRAGMA of data-model.md §1, so the server uses it and needs no SQLite native module (ADR-0006). `onnxruntime-node` loads with lifecycle scripts disabled, so its build stays off (ADR-0005).

## 3. Paths

One source: `packages/contracts/src/paths.ts`. Never build paths from `%USERPROFILE%\Documents` (OneDrive redirection). All paths must work with spaces.

| OS | Client data `{data}` | Client config | Local-mode server data | Local-mode server config |
| --- | --- | --- | --- | --- |
| Windows | `%USERPROFILE%\.memory-anywhere\` | same dir, `client.toml` | `{data}\server\` | same dir, `server.toml` |
| macOS | `~/Library/Application Support/memory-anywhere/` | same dir, `client.toml` | `…/memory-anywhere/server/` | same dir, `server.toml` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/memory-anywhere/` | `${XDG_CONFIG_HOME:-~/.config}/memory-anywhere/client.toml` | `{data}/server/` | `${XDG_CONFIG_HOME:-~/.config}/memory-anywhere/server.toml` |
| AWS instance | n/a | n/a | `/var/lib/memory-anywhere/` | `/etc/memory-anywhere/server.toml` |

`MA_HOME` replaces both the data and config roots (tests use it). Inside `{data}`: `tokens.json`, `tokens.lock`, `local.token` (local mode), `spool\`, `cache\`, `logs\`, `models\` (local mode only). Directory ACLs are user-only on creation (Windows: `icacls <dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`; POSIX: 0700).

Windows folder outside AppData: a shell started by a packaged (MSIX) desktop app, such as the Claude app, runs in that app's container, where files written under `%LOCALAPPDATA%` and `%APPDATA%` go to `%LOCALAPPDATA%\Packages\<family>\LocalCache\{Local,Roaming}\` and only that app sees them. With the PC token there, the app and every other tool would each keep a copy; the token rotates on every refresh, so the two copies would sign each other out. The profile folder is not virtualized, so `{data}` and the config live in `%USERPROFILE%\.memory-anywhere\` ([ADR-0117](../../decisions/ADR-0117-client-folder-outside-appdata.md)). When `MA_HOME` is under AppData, `mema connect`, `mema login` and `mema init` print the container warning and `mema doctor` fails `appdata.virtualized` (clients.md §6).

## 4. CLI

`mema` and `memory-anywhere` are the same binary. Every command takes `--help`; `mema --help` lists them by group, `mema help <command>` and `mema --version` work too, and an unknown flag prints the command's usage. Exit codes: 0 ok; 1 usage error; 2 store unavailable; 3 validation or policy rejection; 4 conflict; 5 step-up denied, expired or not approved; 6 doctor found a failing check. A missing or refused PC grant also exits 5, a client too old for the store exits 3, and an unexpected error exits 1.

### 4.1 Client commands (PC grant)

| Command | Flags | Does |
| --- | --- | --- |
| `mema init` | `--clients <list>` (default: all detected of `claude-code,codex,cursor`), `--dry-run`, `--yes` (no questions: keeps the current deny-list and applies the changes), `--local`, `--print-custom-instruction`, `--from-workspace <path>` (hidden) | clients.md §6. Without `--from-workspace`, init takes the plugins and the client bundle from the installed npm package; with it, it builds them from that repository checkout. `--local` sets up local mode, which for now needs `--from-workspace <path>`: it runs the server built in that checkout (`pnpm build` output), downloads the model and starts the server. Local mode has no upgrade command yet |
| `mema connect <url>` | | Sets `store.url` and `store.mode`, checks `/v1/health`. A remote store must be `https`. Connecting a local-mode PC to a remote store leaves local mode: the start at logon is removed and the local server stopped; its store is kept |
| `mema login` | `--no-browser` | PC grant (auth-and-security.md §5.6) |
| `mema logout` | | Revokes and deletes the PC grant |
| `mema status` | | Calls `/v1/status`; prints store, health, policy version, spool count |
| `mema doctor` | | clients.md §6 |
| `mema sync` | `--quiet` | Drains spool; refreshes profile and repo caches for every enabled repo seen on this PC |
| `mema search <query>` | `--section <name>`, `--limit <1..10>` | Recall from the terminal; same repo-enablement rule and read budget as the proxy (mcp-interface.md §6) |
| `mema ui` | | Opens the admin UI in the browser (aws mode: `https://admin.{host}`; local mode: a one-time login link to `http://127.0.0.1:47821/admin/`) |
| `mema mcp` | `--tool <claude-code\|codex\|cursor\|generic>` | stdio proxy |
| `mema hook <tool> <event>` | | Hook entrypoint; events `session-start`, `prompt` |
| `mema import [<file-or-folder>] --source <id> --dry-run` | `--vendor <name>` (`paste` only), `--since <date>`, `--until <date>`, `--conversation-min-user-turns <n>` (history only, default 2) | Parses and redacts on the PC, then calls `/v1/import/estimate` with counts only; prints counts and the cost estimate; no step-up (write-path.md §10.5). With no file, the instruction-file and coding-tool sources read their user-level default location (importers.md §2); the others need a file, a folder or an export ZIP |
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
| `mema import [<file-or-folder>] --source <id> --commit` | `import` | as `--dry-run`, plus `--resume <batch_id>` | Needs a dry run of the same input in the last 24 h; one step-up per batch, where the owner types the estimate in whole dollars; uploads, waits for extraction and prints the report, counts only (write-path.md §10.5, importers.md §5) |

### 4.3 Deploy and operator commands

| Command | Where | Flags | Profile |
| --- | --- | --- | --- |
| `mema deploy aws` | PC | `--stage <prod\|eval-<id>\|spike>`, `--region`, `--profile` (default `memory-anywhere-deploy`), `--update`, `--release <version>` (without it or `--release-file`, only the stack changes: no release is uploaded and the server is not waited for), `--release-file <tarball>` (non-prod only, dev-signed), `--allow-replace` (lets a `prod` update whose diff replaces the instance proceed), `--replace-instance` (with `--update`: builds a new instance even when nothing else changed, by raising the stack's instance generation; deployment-aws.md §5.5), `--yes` (non-prod only), `--alert-email <address>` (default `MA_ALERT_EMAIL`; the SNS subscription, passed as the `AlertEmail` parameter and never committed). Host from `MA_DOMAIN`. Runs `aws sso logout` on exit for `prod`; keeps the sign-in for non-prod stages | deploy |
| `mema destroy aws` | PC | `--stage` (required), `--region`, `--profile`. On `prod` it keeps the buckets and the KMS key (their removal policy is retain) | deploy |
| `mema cost aws` | PC | `--month <YYYY-MM>` (default the current UTC month), `--profile`. The account's bill per service and usage type (deployment-aws.md §10); signs out after | deploy |
| `./ma-operator.sh setup-link \| set-llm-key \| restore \| reset-owner [--cancel] \| acme-account \| import-export \| delete-data \| pause \| resume \| store-hash` | AWS CloudShell only | per deployment-aws.md §3.2 | operator Identity Center user |

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

`pnpm eval run --suite <R|P|W|C|S|A|I> [--system <name>] [--split <dev|test|unseen|full>] [--llm fake-adversarial] [--model <id> --repeat <n>] [--cases <ids>] [--stack <url> --stage <eval-id> --owner <file>] [--out <file>]`; suite P's ablation: `pnpm eval run --suite P --model <client model> --ablation a|b|c|d [--repeat <n>] [--server-model <ollama model>] [--ollama <url>]` (evals.md §3.3). Thresholds are calibrated by hand from these runs (write-path.md §12). evals.md §9.

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
timezone = "Etc/UTC"             # IANA; used by the time parser and job schedules

[embedding]
model = ""                       # "<hf repo>@<revision sha>", set from ADR-0005
dtype = "q4"                     # q4 (ADR-0005) | q8 | fp32

[llm]
provider = "anthropic"           # anthropic | ollama | openai | none   (local default: none)
model = ""                       # pinned dated model id from ADR-0007; with ollama, the local model's name (required)
endpoint = ""                    # ollama only: its HTTP API, http(s) URL; empty = http://127.0.0.1:11434
judge = false                    # the durability judge (write-path.md §5, §6.2)
daily_usd_cap = 1.00
import_usd_cap = 50.00           # all imports together (write-path.md §10.5)
parallel_extract = 4             # extract jobs run at once, 1-16 (operations.md §4)

[write]
support_min = 0.5                # initial; calibrated per write-path.md §12
capture_support_min = 0.6        # initial; calibrated per write-path.md §12
event_default_ttl_days = 30
event_max_ttl_days = 90          # clamp for model-supplied expires_on (write-path.md D13)
extension_min_cosine = 0.80      # store rule 6 (a): an extension needs only this (write-path.md §8, §12)
import_dup_threshold = 0.85      # store rule 6 (b) on the import channel: a restated fact adds a source
reworded_min_cosine = 0.95       # store rule 6 (c): a swapped word is a synonym only this close

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
| `MA_LLM_API_KEY` | local server | LLM key in local mode (provider `anthropic`; `ollama` needs none) |
| `MA_STORE_URL` | client | Overrides `store.url` (evals) |
| `MA_TOKEN_FILE` | client | Overrides the token file path (evals) |
| `MA_NO_BROWSER` | client | Any non-empty value: never open a browser; sign-in and approval links are printed instead (the model-driven evals set it, so a scripted approval never opens in the owner's browser) |
| `MA_DOMAIN` | `mema deploy aws`, `mema destroy aws`, `mema doctor` | **Required by the deploy commands.** The subdomain used as `{host}` (for example `memory.example.com`), in a DNS zone the owner controls. Owner-specific: never committed to any repository (deployment-aws.md §6.1). Deploy commands refuse to run without it |
