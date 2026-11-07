# memory-anywhere: design (v3)

Nov 7, 2026 · owner: Mayur · status: ready for M0

memory-anywhere is one self-hosted personal memory that Claude, ChatGPT, Gemini, Grok, Cursor, Claude Code, Codex and any other MCP client read and write. One person owns it. The owner's store runs on a small AWS instance in the owner's account; anyone else can run it locally. It is never a hosted service.

This file is the entry point. The normative detail is in `spec/`, the decisions in `decisions/`, and the mapping from every review finding to its resolution in `REVIEW-TRACEABILITY.md`. Previous name: pmem. v3 replaces DESIGN-v2 entirely.

## 1. Goals and non-goals

### Goals

1. **Remember what matters long-term, and nothing else.** Preferences, stable facts, people, ongoing projects, lasting decisions, corrections and explicit requests. Never one-off task details. Measured as stored precision and recall (suite P).
2. **One memory in every app, on the PC and the phone.** Claude, ChatGPT and Gemini on the phone as well as the PC (ChatGPT's phone support is tested in M0 Q01; ADR-0019). Any MCP-capable client works through the standard path: Streamable HTTP, standard OAuth discovery, and policy carried by the server. Per-client hooks, plugins and caches are optional enhancements.
3. **Deterministic, bitemporal, tiered write path** with a measured wrong-supersede rate (suite W).
4. **A security posture for a single-owner public endpoint**, measured as attack success rate (suite S).
5. **Readable memory organized by sections of life**, with bounded dynamic sections and a project catalog that the owner's private career-os repo consumes.
6. **A reusable cross-client benchmark** that runs against memory-anywhere, mem0 OSS, mcp-memory-service and simple baselines.

### Non-goals (v1)

- Enterprise accounts of any vendor; employer data. Capture is opt-in per repo, and a deny-list blocks employer remotes.
- Multi-replica sync, multiple owners, sharing.
- A hosted service; Azure, Docker Compose, Postgres; Lambda.
- An MCP Apps review widget; a reranker; hosted embedding APIs; Bedrock.
- Writing memory into repository files or instruction files (optional projection files are deferred, ADR-0009).
- A built-in tunnel mode; `search`/`fetch` aliases; plaintext debug logging; a scheduled export to S3 (ADR-0023).

## 2. Positioning

Most features exist elsewhere. What memory-anywhere adds is a measured, deterministic write path; a server-enforced memory policy; a security posture tested by attack; and a benchmark anyone can point at their own server.

| System | Already does | memory-anywhere takes or avoids |
| --- | --- | --- |
| [mcp-memory-service](https://pypi.org/project/mcp-memory-service/) 12.7.0 (Nov 7 2026) | Local SQLite + ONNX, OAuth for claude.ai and ChatGPT, Claude Code hooks, transcript harvesting, dashboard | Closest prior art; run as a baseline. Python and broad; its write path is not deterministic |
| [mem0 / OpenMemory](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) | Single-pass add-only extraction; local Docker stack | Take add-only, no LLM deletes; avoid a delete-all tool; run as a baseline |
| [Zep / Graphiti](https://mintlify.com/getzep/graphiti/concepts/temporal-model) | Bitemporal edges, invalidation not deletion | Copy the bitemporal fields; skip the graph DB |
| [Basic Memory](https://docs.basicmemory.com/reference/technical-information) | Markdown files as source of truth | Keep SQLite canonical; render readable text |
| [Supermemory MCP](https://supermemory.ai/docs/supermemory-mcp/introduction) (hosted) | Profile and status tools, guided-save widget | Take profile and status tools |
| [MemoryPlugin](https://www.memoryplugin.com/platforms/mcp) (hosted) | Imports history from many apps | Importing alone is not a differentiator |
| [Hindsight](https://arxiv.org/html/2512.12818v1) | Rank fusion, token-budgeted recall | Take RRF and budgets |

Build new rather than contribute: the claims rest on the write path and the benchmark, which are easier to prove in a small TypeScript codebase. mem0 and mcp-memory-service are run as baselines, so the comparison is published either way.

## 3. Decisions

Owner decisions are binding. "ADR" links give the rationale where reviewers disagreed.

| Topic | Decision |
| --- | --- |
| Name | memory-anywhere. CLI `memory-anywhere`, alias `mema`. npm package `memory-anywhere`. Public GitHub repo, separate from the private career-os repo |
| Accounts | Personal accounts only; never enterprise Claude or ChatGPT. Employer data out of scope |
| Owner topology | Store on AWS from day one; PC runs only a pure-JS client (ADR-0001) |
| Clients | Claude web/desktop/mobile (primary; mobile is the main phone app), ChatGPT Plus on the PC web and on the phone (write and phone surfaces tested in M0 Q01; read-only and known-limitation fallbacks, ADR-0019), Gemini web then mobile, Grok (M0), Cursor (paid), Claude Code, Codex, any MCP client |
| Native vendor memories | Stay on; memory-anywhere is canonical and re-imports them idempotently |
| History extraction | One-time, about $20, estimate shown and confirmed first |
| Build vs contribute | Build new; mem0 OSS and mcp-memory-service as baselines |
| Sensitive categories | Blocked by default; an explicit request stores them pending owner confirmation (ADR-0016) |
| Sections | Nine default sections; dynamic sections created automatically, bounded, with undo (ADR-0018) |
| Eval labels | Public items + labels from non-Claude model families + 50-item owner spot-check (ADR-0015) |
| Eval budget | Cross-vendor runs optional, on the owner's personal API keys, hard cap $30 separate from the $20 import budget; every gate passes without keys (ADR-0022) |
| Trust tiers | From the channel; model fields never raise a tier (ADR-0002) |
| Preferences | Recalled at once; enter the always-loaded profile only when owner-confirmed (ADR-0003) |
| Registration | Pairing window bound to the owner's browser; static client credentials by default for Claude, ChatGPT and Gemini; CIMD and DCR only as fallbacks inside a window (ADR-0017) |
| OAuth library | node-oidc-provider, opaque tokens; Better Auth fallback (ADR-0004) |
| Admin credentials | None stored on any PC; seven CLI admin commands, each approved with a passkey on text the server renders; everything else in the admin UI (auth-and-security.md §6) |
| AWS access | A dedicated member account `memory-anywhere` in an AWS Organization whose management account is the owner's existing account; two Identity Center users with permission sets only in the member account: deploy profile on the PC, operator only in AWS CloudShell; `reset-owner` waits 24 hours (ADR-0020, ADR-0025) |
| Releases | minisign-signed; release key for prod (owner, before M2), dev key for spike and eval (ADR-0021) |
| Projections | No memory content in repos or instruction files by default (ADR-0009) |
| Capture | Prompt hook only; no transcripts or assistant text (ADR-0014) |
| Embedding | One pinned local ONNX model, chosen in M0 (ADR-0005) |
| LLM | Server-side adapter; Anthropic small model pinned; caps $1/day live, $20 import (ADR-0007) |
| AWS | t4g.small, standard credits, Elastic IP, Litestream, no AWS credentials in the server (ADR-0010, ADR-0011) |
| Backups | Purge clears every file on the instance within 48 hours and every AWS backup within 30 days (ADR-0012) |
| Hostname and DNS | Required M0 input `MA_DOMAIN` = `{host}`, a subdomain of a domain the owner already has; the owner's DNS is at Cloudflare. The owner adds DNS-only (not proxied) A records for `{host}` and `admin.{host}` and a CAA record on the subdomain; nothing else in the zone is touched. The value stays out of the repository; the hostname is public via CT logs and is not a secret. Never changed after M2 (deployment-aws.md §6, ADR-0024) |
| Region | By measured RTT from the owner's PC in M0 Q20 |

Open owner items: the eval keys, if any (optional).

## 4. Architecture

```
  ┌──────────────── Owner's Windows PC ────────────────┐      ┌──────── Phone ────────┐
  │ Claude Code   Codex   Cursor   (other MCP client)  │      │ Claude, ChatGPT,      │
  │   │ stdio      │        │                          │      │ Gemini, Grok apps     │
  │   ▼            ▼        ▼                          │      └──────────┬────────────┘
  │ memory-anywhere client (pure JS, no native code)   │                 │
  │  • mema mcp      stdio proxy  ───────────┐         │                 │
  │  • mema hook     session-start, prompt ──┤ HTTPS   │   ┌─────────────▼─────────────┐
  │  • spool, caches, tokens.json (no admin) │ bearer  │   │ Vendor clouds: Claude,    │
  │  • mema CLI (admin cmds need passkey) ───┤         │   │ ChatGPT, Gemini, Grok     │
  │ Browser: admin UI, consent, step-up ─────┤         │   └─────────────┬─────────────┘
  └──────────────────────────────────────────┼─────────┘                 │ HTTPS bearer
                                             │                           │
                         ┌───────────────────▼───────────────────────────▼──────────┐
                         │ AWS · one t4g.small · 443 only · Elastic IP · Caddy TLS   │
                         │  {host}: /mcp  /v1  OAuth AS  consent     admin.{host}: UI │
                         │ ┌──────────────── memory-anywhere-server ───────────────┐ │
                         │ │ MCP handler (5 tools) · internal API /v1 · OAuth +     │ │
                         │ │ pairing + passkeys + step-up · admin UI                │ │
                         │ │ Write path: redact → screens → decision table →        │ │
                         │ │   resolve → store rules (BEGIN IMMEDIATE) → events     │ │
                         │ │ Retrieval: FTS5 + vectors → RRF → filters → budgets    │ │
                         │ │ Embedding model (ONNX, CPU) · LLM adapter · job worker │ │
                         │ └───────────────┬────────────────────────────────────────┘ │
                         │       SQLite (WAL, EBS gp3, KMS)   Litestream (own user)   │
                         └───────────────────────────────────────────┬────────────────┘
                                                                     │ S3 gateway endpoint
                                            S3 backups (SSE-KMS, versioned) · manifest (Object Lock)
```

### 4.1 What runs where

| Place | Runs | Holds |
| --- | --- | --- |
| AWS instance | Caddy, `memory-anywhere-server`, Litestream, secrets loader, outbox, updater, nightly maintenance | SQLite store, embedding model |
| Owner's PC | `memory-anywhere` client: stdio proxy, hooks, CLI, spool, caches; AWS CLI with the deploy profile only | PC grant (no admin), spool, caches; a deploy SSO token only during a deploy |
| AWS CloudShell (in the owner's browser) | `ma-operator.sh` as the operator Identity Center user | Operator credentials, only for that browser session |
| Phone | Vendor apps only | nothing of ours |
| Local mode (other users, dev, evals) | The same server on 127.0.0.1 with a token | Local store |

Full rules: [spec/topology-and-ipc.md](spec/topology-and-ipc.md).

### 4.2 Components

| Package | Responsibility |
| --- | --- |
| `packages/contracts` | Schemas (zod + JSON Schema), normalization, redaction, reason codes, paths. Shared by client and server |
| `packages/server` | MCP handler, `/v1`, OAuth (library config), pairing, passkeys, step-up, admin UI, write path, retrieval, embeddings, LLM adapter, jobs, migrations, policy files |
| `packages/client` | stdio proxy, hooks, CLI, spool, token cache, caches, `init`/`doctor` |
| `packages/importers` | One module per source; produce proposals only |
| `packages/evals` and `evals/` | Harness, adapters, datasets, stats |
| `deploy/aws` | CDK app (`prod`, `eval-<id>`, `spike` stages) |
| `plugins/` | `claude-code`, `codex`, `cursor` |

Repository layout:

```
memory-anywhere/
  packages/{contracts,server,client,importers,evals}/
  plugins/{claude-code,codex,cursor}/
  evals/{adapters,datasets,harness,fixtures}/
  deploy/aws/
  spikes/                 (M0 only)
  config/vendors.json     (values recorded in M0)
  docs/DESIGN.md  docs/spec/  docs/decisions/  docs/results/  docs/REVIEW-TRACEABILITY.md
```

Stack: TypeScript on Node 24 LTS, pnpm workspace, official MCP TypeScript SDK v2, better-sqlite3, onnxruntime-node, oidc-provider, @simplewebauthn/server, Vitest + fast-check, GitHub Actions with Windows, Linux x64, Linux arm64 and macOS arm64 runners.

### 4.3 How a save flows

1. A model calls `memory_save` (chat app via its cloud; coding tool via the proxy).
2. The server authenticates the grant, checks quotas and the repo (coding), validates, and checks idempotency.
3. Screens: secrets, action instructions, sensitive categories, suppressions, short-lived wording.
4. The decision table maps the proposal to active, observation, review or rejected, with a reason the model sees at once.
5. Resolution picks entity, attribute (registry only) and section deterministically; an LLM may only propose an attribute.
6. Store rules decide insert, add source, update, correction, historical or contested inside one transaction; nothing is overwritten.
7. The commit writes versions, sources, FTS, embedding, hash-chained events and the idempotency record.

[spec/write-path.md](spec/write-path.md) has every row.

## 5. Memory policy in one page

- The test: would this still be true and useful a month from now, in a conversation about something else?
- Remember: preferences about how to answer; stable facts; people and relations; ongoing projects; lasting decisions; corrections; explicit requests; time-bound context as events.
- Don't remember: task details; unadopted suggestions; document, web, email or tool content; generic questions; single passing tastes (staged until they recur in a second session); secrets (never); sensitive categories unless explicitly requested, and then only with owner confirmation; sensitive facts about other people (never).
- The same policy text reaches every client through server instructions, tool descriptions, a profile header, a skill, a Cursor rule and a custom instruction, each within a size budget. The server re-checks every save, because it cannot trust the model.

Full text and budgets: [spec/memory-policy.md](spec/memory-policy.md).

## 6. Spec index

| File | Covers |
| --- | --- |
| [spec/topology-and-ipc.md](spec/topology-and-ipc.md) | Modes, what runs where, request paths, local mode, stdio proxy, offline behaviour, projections pull, hostname and moves, repo key, spool, token cache, version skew |
| [spec/data-model.md](spec/data-model.md) | DDL, views, seeds (sections, attributes), memory and version semantics, tiers, embeddings, purge scope, exports, project catalog contract, store hash |
| [spec/memory-policy.md](spec/memory-policy.md) | Policy text, computed definitions, lexicons, channel budgets, verbatim channel texts, sensitive rules, observations, sections, project catalog, versioning |
| [spec/write-path.md](spec/write-path.md) | Pipeline, channels and tiers, idempotency, redaction, decision table D1–D19 (with D10a, D13b), resolution, LLM adapter, store rules 0–7 (with 4a), forget/suppression/purge, capture and import extraction, thresholds, tests |
| [spec/retrieval.md](spec/retrieval.md) | Recall pipeline, time semantics, scopes, read budgets, output, profile algorithm, session-start context, escaping, embedding model |
| [spec/mcp-interface.md](spec/mcp-interface.md) | Server settings, JSON schemas for all five tools, annotations, errors, elicitation, scopes, internal `/v1` API |
| [spec/clients.md](spec/clients.md) | Standard path, client matrix, Claude Code / Codex / Cursor plugins and hooks, chat-app setup, approvals, caches, init and doctor |
| [spec/auth-and-security.md](spec/auth-and-security.md) | Threat model, origins, passkeys and recovery, pairing window, CIMD/DCR rules, tokens, PC grant, step-up, untrusted inputs, web-surface security, process containment, supply chain |
| [spec/deployment-aws.md](spec/deployment-aws.md) | Resources, IAM, host config, backups and retention, restore, DNS, deploy and update, eval and spike stacks, cost, region |
| [spec/config-and-cli.md](spec/config-and-cli.md) | Packages, toolchain, paths per OS, every CLI command and flag, `server.toml`, `client.toml`, environment |
| [spec/operations.md](spec/operations.md) | Logging, alerts, rate limits, jobs, health, migrations, upgrades, error handling, testing strategy, CI |
| [spec/importers.md](spec/importers.md) | Import rules, sources, history extraction, native re-import |
| [spec/evals.md](spec/evals.md) | Suites W R P A X S C I, datasets, labelling, statistics, baselines, harness adapters, gates |
| [spec/m0-spike.md](spec/m0-spike.md) | Spike build, questions Q01–Q27 with pass/fail and fallbacks, OAuth conformance list, M0 done |
| [decisions/](decisions/) | ADR-0001…0025 (design decisions); ADR-0101…0113 are written during M0 as listed in m0-spike.md §4 (some cover several questions, and Q01, Q14, Q15, Q16, Q22 update ADR-0019, 0005, 0004, 0007, 0006); `ADR-template.md` |
| [REVIEW-TRACEABILITY.md](REVIEW-TRACEABILITY.md) | Every review finding and where it is resolved or why it is rejected |

Precedence when two files seem to disagree: the file that owns the topic (index above) wins; report the conflict as a bug in the spec.

## 7. Milestones

Milestones are gates, not durations. Claude Code builds everything. The owner performs only account steps: the pre-M0 checklist (§9.1), including the AWS Organization, member account and Identity Center steps; the one-time AWS bootstrap in CloudShell when Claude Code asks; `aws sso login` for each deploy; CloudShell operator commands (setup link, LLM key); the SNS email confirmation; creating the release signing key and the export age keypair before M2 and registering the age public key in the admin UI; adding connectors and pasting the custom instruction in each app; approving hooks; enrolling passkeys and approving step-up requests; and the 50-item spot-check.

| Milestone | Builds | Gate (all must hold) | Explicit non-goals |
| --- | --- | --- | --- |
| **M0 Spike** | m0-spike.md §1: stub server, the node-oidc-provider spike (Better Auth only if it fails), hook recorder, embed bench on a public LongMemEval-S subset (model chosen on its dev split), IAM policy files and the two bootstrap scripts, operator script, Litestream probe, dev signing key, CDK spike stack, eval skeleton; `packages/client` deploy subcommands only (`mema deploy aws`, `mema destroy aws`, implementing deployment-aws.md §6.2–§6.3, §7.1, §7.4); no other client code | m0-spike.md §6: every Q01–Q27 (except withdrawn Q23) has an ADR; Q25 passes; spike stack destroyed; no eval API key needed | No real store, no real data, no core code beyond the deploy subcommands |
| **M1 Core (local mode)** | `contracts` first (schemas committed before code); schema 0001 + seeds; write path (all rows and rules); retrieval; profile; five tools; `/v1`; local mode server; client: proxy, hooks, spool, caches, init, doctor; Claude Code plugin, then Codex and Cursor; policy generator and channel texts; sections (placement, dynamic job); observations; no-LLM mode | Suite W gate (≥ 300 cases, 0 wrong supersedes on ≥ 100 eligible); R gate on the LongMemEval-S subset; P server-stage gates (0/n secrets and sensitive, n ≥ 100); local mode installed with `mema init --local --from-workspace`; C local; unit tests per decision row and store rule; property tests; contract tests (schemas, budgets, generated policy); Windows CI with spaces in paths; a Claude Code session in an enabled repo on the owner's PC (local mode) gets session-start context, saves with an outcome, and recalls in a new session; same for Codex and Cursor or an ADR says why not | No OAuth, no AWS, no admin UI, no LLM calls by the product (adapter runs as `none`; optional eval-key runs within the $30 cap), no importers, no real owner data |
| **M2 Owner store on AWS with security baseline** | CI release workflow signing with the owner's release key; `prod` stack; OAuth (library), pairing, passkeys with bootstrap and recovery, step-up with server-rendered approvals, admin UI v1 (auth-and-security.md §8.1); rate limits, alerts, audit, nightly maintenance; LLM adapter (slot proposal; judge only if P shows gain); elicitation where M0 allowed; owner connects Claude (web, desktop, mobile), ChatGPT (PC web and, if Q01 passed, the phone), Gemini, Grok, and the PC | OAuth conformance (m0-spike.md §5) against an eval stack running the same release, plus the non-mutating subset (tests 1–6, 15–18) against `prod`; S deterministic families all pass (incl. S-WEB-05, S-PURGE with Litestream running); model-driven S baseline recorded; X for all supported pairs including Claude mobile, Gemini mobile and any working ChatGPT phone surface; A reported per client; P model stage (Claude Code headless) reported; R on full LongMemEval-S retrieval; C remote targets | No importers; no full red team |
| **M3 Importers** | importers.md: atomic sources, then history extraction with estimate and confirmation; capture extraction with LLM | Suite I gates; re-import no-op (content hash); W capture items; S-POI-09; history run within the confirmed estimate and ≤ $20 | No new sources beyond the table |
| **M4 Hardening and drills** | Restore drill; measured bill; red-team pass (≥ 30 new S cases); full device matrix; Object-Lock manifest bucket and manifest checks | Restore: restored store hash equals pre-deletion hash; RTO ≤ 30 min measured; S full re-run, no regressions; X full matrix (ChatGPT phone rows per Q01 and ADR-0019); monthly cost measured and the README states it | |
| **M5 Release and report** | Plugins and npm package published with provenance; README (accepted risks, purge guarantee, local mode); benchmark report at full eval sizes, with mem0 OSS and mcp-memory-service baselines and the policy ablation | Fresh install on Windows, macOS and Linux in under 10 minutes to a working Claude Code session against an eval stack; report with every suite, baselines, CIs, ablation, negative results; written comparison with mem0 and mcp-memory-service | |

Each milestone ends with: the ADRs it produced, an updated `docs/results/negative-results.md`, and a short `docs/results/<milestone>.md` listing gate results with links to result files.

After v1: Docker Compose, Postgres, Azure, multi-replica sync, MCP Apps guided save, reranker, Bedrock as a separate process, SEA binary.

## 8. How it fits career-os

- career-os is private; memory-anywhere is public. career-os reads the project catalog with `mema export --section projects --format json` (data-model.md §11), never the store.
- The Projects section is the live catalog: a project is registered when the owner enables a repo, and decisions, stack and outcomes accumulate through the write path.
- career-os gets a project page linking the public repo, the ADRs, the benchmark report and the negative-results log.

## 9. Owner pre-M0 checklist and hand-off

### 9.1 Before M0 (owner, account steps only)

| # | Step | Result Claude Code needs |
| --- | --- | --- |
| 1 | Create the public GitHub repo `memory-anywhere` and copy `docs/` from this spec | Repo URL |
| 2 | **Choose the subdomain** for memory-anywhere in a domain you already control (your DNS is at Cloudflare). Set `MA_DOMAIN` to it in your environment and in `%APPDATA%\memory-anywhere\deploy.toml`; it is never committed. Do not change the apex or existing records. When Claude Code prints them, add in Cloudflare: A `{host}` and A `admin.{host}` → the Elastic IP, both **DNS only (grey cloud)**, and CAA on the subdomain `0 issue "letsencrypt.org"`; for M0 also A `spike.{host}`. Delete records when a stack is destroyed (deployment-aws.md §6) | `MA_DOMAIN`, for example `memory.example.com` |
| 3 | AWS: in the existing account (signed in as root or an existing administrator), follow deployment-aws.md §3.2 part A in order: (1) **create an AWS Organization**, which makes this account the management account and leaves its workloads untouched; (2) **create the member account** `memory-anywhere` with its own email (plus-addressing works, for example `you+ma-aws@example.com`); (3) **enable IAM Identity Center as an organization instance** (account instances cannot assign permission sets), with MFA required and a 1-hour session; (4) **create users** `ma-deploy` and `ma-operator` with two different email addresses (`you+ma-deploy@example.com`, `you+ma-operator@example.com`), each with its own MFA device; (5) **create the predefined permission set `AdministratorAccess`**; (6) **assign it to `ma-operator` on the `memory-anywhere` account only**, temporarily. The bootstrap in M0 creates the real permission sets and removes this assignment. Root user of the existing account: hardware MFA, no access keys | Management account id, member account id, Identity Center start URL and the Identity Center region (used by `bootstrap-identity.sh`; it may differ from the deployment region) |
| 4 | On the PC, put the `[sso-session ma-deploy]` and `[profile memory-anywhere-deploy]` blocks of deployment-aws.md §3.2 part B in `~/.aws/config`, with the member account id and **no `region` line** (Claude Code gives it after M0 Q20). Nothing for the operator goes on the PC | Profile name `memory-anywhere-deploy` |
| 5 | Optional: personal API keys for cross-vendor eval runs (Anthropic, OpenAI, Google), capped at $30 in total (ADR-0022). Skip this to run every gate without them | `MA_EVAL_*` environment variables, or nothing |
| 6 | Install on the PC: AWS CLI v2, minisign (official Windows release) and age (official Windows release), plus the apps M0 uses: Claude (PC and phone), ChatGPT (PC web; phone app), Gemini (web; phone app), Grok, Claude Code, Codex, Cursor | — |

During M0 the owner also runs the one-time bootstrap in CloudShell when Claude Code asks (deployment-aws.md §3.3: first `bootstrap-member.sh` in the member account as `ma-operator` with the temporary `AdministratorAccess`, then `bootstrap-identity.sh` in the management account, which creates the two permission sets, assigns them in the member account only, and removes the temporary assignment).

Before M2 the owner: creates the release signing key (`minisign -G -W`, deployment-aws.md §7.4) and stores it as the GitHub environment secret; creates an age keypair for exports (`age-keygen -o owner-export.key`), keeps the identity file offline (password manager), and after setup registers its public key in the admin UI as an export recipient (data-model.md §10).

### 9.2 Hand-off prompt

Start Claude Code in the repo, one milestone at a time:

```
Read docs/DESIGN.md and every file it indexes. Implement milestone M0 only (docs/spec/m0-spike.md).
Start in plan mode and show me the plan before writing code.
I'm on Windows; every script, path and hook must work there, including paths with spaces.
MA_DOMAIN is set in my environment (never write its value into the repo). Eval API keys: <none | set in my environment>.
For each spike question, write the ADR named in m0-spike.md with the result, including failures.
Ask me before installing global tools, changing anything outside this repo, or using any of my accounts.
I will do the account steps myself. Use only the memory-anywhere-deploy AWS profile, and only after I sign in for a deploy.
Never ask me for operator credentials; operator steps are mine, in CloudShell.
If the spec is ambiguous or contradicts itself, stop and ask; do not invent behaviour.
```

## 10. Sources

Primary sources are cited inline in each spec file where they drive a decision. Key ones: [MCP 2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx), [MCP security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices), [Claude connector auth](https://www.claude.com/docs/connectors/building/authentication), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Cursor hooks](https://cursor.com/docs/agent/hooks), [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode), [OpenAI Apps auth](https://developers.openai.com/apps-sdk/build/auth), [Gemini custom apps](https://support.google.com/gemini/answer/17209137), [Litestream config](https://litestream.io/reference/config/), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [LongMemEval](https://arxiv.org/abs/2410.10813v2), [MemoryAgentBench](https://huggingface.co/papers/2507.05257), [HaluMem](https://huggingface.co/papers/2511.03506).
