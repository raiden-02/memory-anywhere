# 07 · Architecture

At the end of this chapter you will know what runs where, how a save and a recall travel through the
code, which package owns what, and which spec to open for any rule. It assumes
[01 · How it works](../guide/01-how-it-works.md).

## 1. Goals, and what is left out

1. **Remember what matters long-term, and nothing else.** Preferences, stable facts, people, ongoing
   projects, lasting decisions, corrections and explicit requests; never one-off task details. Measured as
   stored precision and recall (suite P).
2. **One memory in every app, on the PC and the phone.** Any MCP client works through the standard path:
   Streamable HTTP, standard OAuth discovery, and a policy the server carries. Hooks, plugins and caches
   are optional improvements per client.
3. **A deterministic, bitemporal, tiered write path** with a measured wrong-supersede rate (suite W).
4. **A security posture for a single-owner public endpoint**, measured as attack success rate (suite S).
5. **Readable memory organized by sections of life**, with bounded dynamic sections and a project catalog
   other tools can read (`mema export --section projects --format json`).
6. **A reusable cross-client benchmark** that runs against memory-anywhere and other memory servers.

Left out on purpose: enterprise accounts and employer data (capture is opt-in per repository, and a
deny-list blocks employer remotes); several owners, sharing or sync between replicas; a hosted service;
writing memory into repository or instruction files ([ADR-0009](../decisions/ADR-0009-projections.md));
a reranker or hosted embedding APIs.

## 2. Where it sits among similar tools

Most single features exist elsewhere. What memory-anywhere adds is a measured, deterministic write path; a
memory policy the server enforces; a security posture tested by attack; and a benchmark anyone can point
at their own server.

| System | Already does | memory-anywhere takes or avoids |
| --- | --- | --- |
| [mcp-memory-service](https://pypi.org/project/mcp-memory-service/) | Local SQLite and ONNX, OAuth for claude.ai and ChatGPT, Claude Code hooks, transcript harvesting, dashboard | Closest prior art; run as a baseline. Its write path is not deterministic |
| [mem0 / OpenMemory](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) | Single-pass add-only extraction; local stack | Take add-only, no deletes by a model; avoid a delete-all tool; run as a baseline |
| [Zep / Graphiti](https://mintlify.com/getzep/graphiti/concepts/temporal-model) | Bitemporal edges, invalidation instead of deletion | Copy the bitemporal fields; skip the graph database |
| [Basic Memory](https://docs.basicmemory.com/reference/technical-information) | Markdown files as the source of truth | Keep SQLite canonical; render readable text |
| [Supermemory MCP](https://supermemory.ai/docs/supermemory-mcp/introduction) | Profile and status tools | Take profile and status tools |
| [Hindsight](https://arxiv.org/html/2512.12818v1) | Rank fusion, token-budgeted recall | Take rank fusion and budgets |

## 3. What runs where

The picture: the owner's PC and phone are clients; the store is one machine with one door (port 443).
Everything else stays outside that machine.

```
  ┌──────────── Owner's PC ─────────────┐        ┌──── Phone ────┐
  │ Claude Code  Codex  Cursor          │        │ Claude, ChatGPT│
  │      │ stdio                        │        │ Gemini, Grok   │
  │      ▼                              │        └───────┬────────┘
  │ memory-anywhere client (pure JS)    │                │
  │  mema mcp · mema hook · spool · CLI │──HTTPS──┐      ▼
  │ browser: admin page, consent        │         │  vendor clouds
  └─────────────────────────────────────┘         │      │ HTTPS
                                                  ▼      ▼
                     ┌──────── one machine · 443 only · TLS ────────┐
                     │ {host}: /mcp  /v1  OAuth   admin.{host}: UI  │
                     │ memory-anywhere-server                       │
                     │   tools → write path | recall → SQLite       │
                     │   embedding model (CPU) · LLM adapter · jobs │
                     │ SQLite ──▶ Litestream ──▶ S3 (versioned, KMS) │
                     └───────────────────────────────────────────────┘
                                   daily manifest ──▶ locked bucket
```

| Place | Runs | Holds |
| --- | --- | --- |
| Your own AWS machine | Caddy (TLS), `memory-anywhere-server`, Litestream, the updater, nightly maintenance | The SQLite store and the embedding model |
| The owner's PC | The `memory-anywhere` client: stdio proxy, hooks, CLI, spool, caches; the AWS CLI with the deploy profile only | The PC's sign-in (no admin rights), queued saves, caches |
| AWS CloudShell | `ma-operator.sh`, as the operator user | Operator credentials, for that browser session only |
| Phone | The vendors' apps | Nothing of ours |
| Local mode | The same server on 127.0.0.1 with a local token | The local store |

Full rules: [topology-and-ipc](spec/topology-and-ipc.md).

## 4. The packages

| Package | Owns |
| --- | --- |
| [`packages/contracts`](../../packages/contracts) | Schemas (zod and JSON Schema), normalization, redaction, reason codes, paths; shared by client and server |
| [`packages/server`](../../packages/server) | The MCP handler and `/v1`, OAuth, pairing, passkeys, step-up, the admin pages, the write path, recall, embeddings, the LLM adapter, jobs, migrations, policy files. Its [README](../../packages/server/README.md) maps the folders and the request path |
| [`packages/client`](../../packages/client) | The `mema` CLI, the stdio proxy, hooks, the spool, the token cache, `init`, `doctor`, `deploy` |
| [`packages/importers`](../../packages/importers) | One module per source; each produces proposals only |
| [`evals/`](../../evals) | The benchmark harness, adapters, datasets and statistics |
| [`deploy/aws`](../../deploy/aws) | The CDK app (stages `prod`, `eval-<id>`, `spike`), host scripts, IAM policies |
| [`plugins/`](../../plugins) | The Claude Code, Codex and Cursor plugins |

Stack: TypeScript run directly by Node 24 (type stripping), a pnpm workspace, the official MCP TypeScript
SDK, `node:sqlite`, onnxruntime-node, oidc-provider, @simplewebauthn/server, Vitest with fast-check, and
CI on Windows, Linux x64, Linux arm64 and macOS arm64.

## 5. How a save flows

1. A model calls `memory_save` (a chat app through its cloud; a coding tool through the proxy).
2. The server identifies the app from its token, checks its quota and (for a coding tool) the repository,
   validates the input, and returns the stored answer if this exact request was already handled.
3. **Screens**: secrets, standing instructions, sensitive categories, earlier forgets, short-lived wording.
4. **The decision table** maps the save to active, observation, review or rejected, with a reason the model
   sees at once.
5. **Resolution** picks the entity, attribute and section from fixed registries; a model may only propose
   an attribute.
6. **Store rules** decide insert, add a source, update, correction, history or contest, inside one
   transaction; nothing is overwritten.
7. The commit writes the version, its sources, the search entry, the embedding, hash-chained events and the
   idempotency record.

Every row and rule: [write-path](spec/write-path.md).

## 6. How a recall flows

1. The query must name something specific (at least two content words, or one long one).
2. Dates in the query ("last spring") boost matching facts; "used to" brings in past versions.
3. Two candidate lists: full-text search and vector search, 50 each.
4. Reciprocal rank fusion merges them; filters remove what this app may not see; boosts favour pinned,
   owner-said and recent facts.
5. If nothing matches well enough, the answer is "no stored memory matches" rather than a weak guess.
6. The read budget caps how much one app reads; the result is rendered as escaped notes within 8,000
   characters, and the read is recorded after the response is sent.

Every step: [retrieval](spec/retrieval.md).

## 7. The memory policy in one page

- The test: would this still be true and useful a month from now, in a conversation about something else?
- Remember: preferences about how to answer; stable facts; people and relations; ongoing projects; lasting
  decisions; corrections; explicit requests; time-bound context as events.
- Do not remember: task details; suggestions the user did not adopt; document, web, email or tool content;
  generic questions; single passing tastes (held until they recur in a second session); secrets (never);
  sensitive categories unless explicitly requested, and then only with the owner's confirmation; sensitive
  facts about other people (never).
- The same policy text reaches every client through server instructions, tool descriptions, a profile
  header, a skill, a Cursor rule and a custom instruction, each within a size budget. The server re-checks
  every save, because it cannot trust the model.

Full text and budgets: [memory-policy](spec/memory-policy.md).

## 8. Which spec owns what

| Spec | Covers |
| --- | --- |
| [topology-and-ipc](spec/topology-and-ipc.md) | Modes, what runs where, request paths, local mode, the stdio proxy, offline behaviour, hostnames, the repository key, the spool, the token cache, version skew |
| [data-model](spec/data-model.md) | The schema, seeds (sections, attributes), memory and version semantics, tiers, embeddings, purge scope, exports, the project catalog, the store hash |
| [memory-policy](spec/memory-policy.md) | The policy text, computed definitions, lexicons, channel budgets, the channel texts verbatim, sensitive rules, observations, sections |
| [write-path](spec/write-path.md) | The pipeline, channels and tiers, idempotency, redaction, the decision table D1–D19, resolution, the LLM adapter, store rules 0–7, forget, suppression and purge, capture and import extraction, thresholds |
| [retrieval](spec/retrieval.md) | The recall pipeline, time semantics, scopes, read budgets, output, the profile, session-start context, escaping, the embedding model |
| [mcp-interface](spec/mcp-interface.md) | Server settings, JSON schemas of the five tools, annotations, errors, elicitation, scopes, the internal `/v1` API |
| [clients](spec/clients.md) | The standard path, the client matrix, plugins and hooks, chat-app setup, approvals, caches, `init` and `doctor` |
| [auth-and-security](spec/auth-and-security.md) | The threat model, origins, passkeys and recovery, the pairing window, client registration, tokens, the PC's sign-in, step-up, untrusted input, web security, process containment, the supply chain, OAuth conformance tests |
| [deployment-aws](spec/deployment-aws.md) | Resources, IAM, host configuration, backups and retention, restore, DNS, deploy and update, eval and spike stacks, cost, region |
| [config-and-cli](spec/config-and-cli.md) | Packages, toolchain, paths per OS, every command and flag, `server.toml`, `client.toml`, environment |
| [operations](spec/operations.md) | Logging, alerts, rate limits, jobs, health, migrations, upgrades, error handling, testing strategy, CI |
| [importers](spec/importers.md) | Import rules, sources, history extraction, re-importing an app's own memory |
| [evals](spec/evals.md) | Suites W R P A X S C I, datasets, labelling, statistics, baselines, harness adapters, gates |

When two specs seem to disagree, the one that owns the topic wins; report the disagreement as a bug.
Why a choice was made: [decisions](../decisions/README.md).

Next: [08 · The specs](spec/), or [10 · Results](../results/report.md).
