# Decision records

An architecture decision record (ADR) states one decision, the options that were weighed, and why one was chosen; it keeps its date and context, so it shows what was known at the time. Open one when the spec states a rule and you want to know why, or before changing that rule, so you can see which constraint or measurement you would be undoing.

## Design decisions (0001–0025)

Made from the requirements and reviews, before or while building.

| ADR | Title | Decision |
| --- | --- | --- |
| [0001](ADR-0001-owner-topology.md) | Owner topology | The store lives on AWS; the PC runs only a pure-JS client, and local mode is the same server on 127.0.0.1. |
| [0002](ADR-0002-trust-tiers.md) | Trust tiers | The tier comes from the channel; T1 needs an elicitation the server can verify, because model-written `user_words` prove nothing. |
| [0003](ADR-0003-preferences-and-profile.md) | Preferences and the profile | Preferences are recalled at once but enter the always-loaded profile only after the owner confirms them. |
| [0004](ADR-0004-oauth-library.md) | OAuth library | node-oidc-provider with opaque, hashed tokens; it passed all 20 conformance tests, so Better Auth was never needed. |
| [0005](ADR-0005-embedding-model.md) | Embedding model | EmbeddingGemma-300m q4: the best hybrid retrieval among the models that meet the latency and memory limits. |
| [0006](ADR-0006-packaging-and-local-ipc.md) | Packaging and local IPC | No native modules: a pure-JS client, loopback plus a token for local mode, and `node:sqlite` on the server. |
| [0007](ADR-0007-llm-models.md) | LLM models | One server-side adapter; the extractor is `claude-haiku-5-5`, and labelling uses non-Claude families. |
| [0008](ADR-0008-observation-promotion.md) | Observation promotion | An observation becomes a memory after two distinct sessions, not after a number of mentions. |
| [0009](ADR-0009-projections.md) | Projections | No memory content is written into repositories or instruction files; coding tools get it from the session-start hook. |
| [0010](ADR-0010-no-aws-credentials-in-server.md) | No AWS credentials in the server | IMDS is blocked for the server; a separate user reads secrets and sends to AWS through an outbox. |
| [0011](ADR-0011-cpu-credits.md) | CPU credits | t4g.small with standard credits, so a flood throttles instead of adding to the bill. |
| [0012](ADR-0012-backup-retention.md) | Backup retention | Backups are kept short enough that a purge reaches every AWS copy within 30 days. |
| [0013](ADR-0013-section-visibility.md) | Section visibility | Each client has a section allow-list; repo and portfolio fields are never returned over MCP. |
| [0014](ADR-0014-capture-source.md) | Capture source | Capture reads only the prompt hook's prompt field; no transcripts, no assistant text. |
| [0015](ADR-0015-eval-labelling.md) | Eval labelling | Public items plus labels from two non-Claude families, with a 50-item owner spot-check. |
| [0016](ADR-0016-sensitive-explicit-requests.md) | Sensitive saves | A claimed explicit request stores a sensitive fact for owner review; it is never active without a confirmation. |
| [0017](ADR-0017-pairing-window.md) | Pairing window | A client can register or get a grant only inside a 10-minute window the owner opens with a passkey. |
| [0018](ADR-0018-dynamic-sections.md) | Dynamic sections | Sections are created automatically with undo; their descriptions reach models only after approval. |
| [0019](ADR-0019-chatgpt-on-the-phone.md) | ChatGPT on the phone | Supported through the ChatGPT phone app, using the grant made on the web. |
| [0020](ADR-0020-aws-operator-separation.md) | Deploy and operator separation | Two Identity Center users; operator work happens only in CloudShell, so the PC never holds operator credentials. |
| [0021](ADR-0021-release-signing.md) | Release signing | minisign: a CI-held release key for `prod`, and a dev key trusted only by spike and eval stacks. |
| [0022](ADR-0022-eval-budget.md) | Eval budget | Eval API keys are optional with a hard $30 cap, and every gate has a no-key path. |
| [0023](ADR-0023-round3-scope-cuts.md) | Scope cuts | Ten over-engineered items are cut or deferred; the table says what was kept and why. |
| [0024](ADR-0024-dns-at-cloudflare.md) | DNS at Cloudflare | The owner adds DNS-only records by hand; the project holds no DNS credential and never proxies. |
| [0025](ADR-0025-dedicated-member-account.md) | Dedicated member account | Every memory-anywhere resource lives in its own AWS member account. |

## Measured on real apps (0101–0117)

Each of these ran the question against the real client or cloud, and records the method and the result next to the decision.

| ADR | Title | Decision |
| --- | --- | --- |
| [0101](ADR-0101-chatgpt-pc.md) | ChatGPT on the PC | ChatGPT gets a read-write grant; its approval card stays. |
| [0102](ADR-0102-chatgpt-registration.md) | ChatGPT registration | Static confidential client with `client_secret_basic`; grants must not depend on `offline_access`. |
| [0103](ADR-0103-claude-connector.md) | Claude connector | Static confidential client; one connector serves every Claude surface, and tool loading is an account-wide setting. |
| [0104](ADR-0104-instructions-descriptions-custom-instructions.md) | Instructions and descriptions | Server instructions reach only stdio clients, so remote clients rely on tool descriptions plus a custom instruction. |
| [0105](ADR-0105-claude-code-tool-loading-and-connector.md) | Claude Code tool loading | Keep both `alwaysLoad` flags; `mema init` hides the duplicate claude.ai connector with `deniedMcpServers`. |
| [0106](ADR-0106-elicitation.md) | Elicitation | Only Claude shows the question to the human, so only Claude can reach T1. |
| [0107](ADR-0107-gemini.md) | Gemini | Static confidential client with fixed refresh tokens; the per-user redirect is matched by a rule. |
| [0108](ADR-0108-grok.md) | Grok | DCR inside the pairing window, the only method Grok's dialog allows. |
| [0109](ADR-0109-coding-tool-hooks.md) | Coding-tool hooks | The hooks work as specified on Windows, with no shim; Cursor's hook script must live outside `%LOCALAPPDATA%`. |
| [0110](ADR-0110-coding-tool-plugins.md) | Coding-tool plugins | Claude Code and Codex ship plugins; Cursor gets a plugin for MCP and the rule, and `init` writes its hooks. |
| [0111](ADR-0111-gemini-api-eval-harness.md) | Gemini API eval harness | Rejected: no Google eval key, so Gemini eval rows are run by hand. |
| [0112](ADR-0112-region-and-litestream.md) | Region and Litestream | us-east-1; the Litestream config works as written once the store file is created with mode 0660. |
| [0113](ADR-0113-identity-center-separation-and-operator-path.md) | Identity Center separation | The deploy sign-in reaches nothing beyond deploy; the operator path works from CloudShell. |
| [0114](ADR-0114-cursor-tools-repo.md) | Cursor repo detection | Hooks tell the proxy the repo, and the proxy recognises when Cursor runs it. |
| [0115](ADR-0115-chat-export-formats.md) | Chat export formats | Importers read only the owner's own messages, by named fields, and skip anything else. |
| [0116](ADR-0116-daily-manifests.md) | Daily manifests | A daily manifest goes to an Object Lock bucket through the outbox and is checked daily and on restore. |
| [0117](ADR-0117-client-folder-outside-appdata.md) | Client folder on Windows | The client folder moves to `%USERPROFILE%\.memory-anywhere`, where packaged apps do not get a private copy. |

New records start from [the template](ADR-template.md).
