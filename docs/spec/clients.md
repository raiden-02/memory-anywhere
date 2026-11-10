# Clients

Status: normative, except items marked **(M0 Qnn)**, whose outcome is recorded in an ADR and selects one of the fallbacks given here. Every design below works under either outcome.

## 1. Principle: the standard path first

Any MCP-capable harness works with memory-anywhere through the standard path alone:

1. Streamable HTTP at `https://{host}/mcp`.
2. Standard OAuth discovery: 401 + `WWW-Authenticate` → protected-resource metadata (RFC 9728) → authorization-server metadata (RFC 8414) → client registration by CIMD, DCR or pre-registered credentials (each only inside a pairing window, auth-and-security.md §4) → authorization code + PKCE S256.
3. The policy travels with the server: server instructions, tool descriptions, and the outcome messages returned by `memory_save`. Server instructions reach the model only through stdio clients (Claude Code, Codex, Cursor). Every remote chat app tested in M0 drops them, so for those apps the tool descriptions and the custom instruction carry the policy (ADR-0104).

Hooks, plugins, skills, rules, projections and custom instructions are optional enhancements. No feature of the store depends on them. The server identifies clients only by the OAuth grant (`client_policy`), never by user agent or headers.

## 2. Client matrix

| Client | Route | Registration (default → fallback) | Grant scopes | Client policy defaults | Owner steps |
| --- | --- | --- | --- | --- | --- |
| Claude web, desktop, mobile | Vendor cloud → `/mcp` | Static confidential client (client id and secret entered in the custom-connector dialog; works, ADR-0103) → CIMD → DCR in pairing window | read, write | class chat; sections all; save_floor none | Pair in admin UI; add custom connector on claude.ai; optionally set its Tool permissions to Always allow; paste the custom instruction |
| ChatGPT (Plus, Developer Mode): web on the PC; on the phone through the app or the phone browser if M0 Q01 shows either works | Vendor cloud → `/mcp` | Static confidential client created in the pairing window, redirect `https://chatgpt.com/connector_platform_oauth_redirect` → CIMD (`https://chatgpt.com/oauth/client.json`) → DCR. Static works (ADR-0102) | read, write (ADR-0101) | class chat; save_floor none | Pair; chatgpt.com/plugins → Add → Add custom MCP server → OAuth → Advanced OAuth settings → User-Defined OAuth Client (`client_secret_basic`); paste the custom instruction |
| Gemini web (Developer Mode, 3.1 Pro) | Vendor cloud → `/mcp` | Static confidential client entered under Developer Mode → Create new → Connect to an MCP server → Additional settings; redirect per user and server, matched by the rule in `config/vendors.json` (ADR-0107) → DCR in pairing window | read, write | class chat; sections Profile, Preferences, Interests, Tools and setup; save_floor observation; refresh_rotation fixed (rotation also tested and works, ADR-0107) | Pair; add the app at gemini.google.com and finish with "Save your custom app" → Connect (Keep Activity must be on) |
| Grok (grok.com) | Vendor cloud → `/mcp` | DCR inside the pairing window: its dialog takes only a name and URL (ADR-0108) | read, write | class chat; sections as Gemini; save_floor observation | Pair; grok.com/connectors → New Connector → Custom; authorize in Grok's popup |
| Claude Code | stdio → `mema mcp --tool claude-code` → `/mcp` | PC grant (`mema login`) | PC grant | class coding | Install plugin; approve hooks if asked; `mema enable` per repo |
| Codex (CLI, desktop app, IDE extension) | stdio → `mema mcp --tool codex` → `/mcp` | PC grant | PC grant | class coding | Install plugin (CLI, desktop) and trust hooks in `/hooks`; IDE extension uses `config.toml` only |
| Cursor (paid) | stdio → `mema mcp --tool cursor` → `/mcp` | PC grant | PC grant | class coding | Install the plugin (MCP server and rule); `mema init` writes `~/.cursor/hooks.json` (ADR-0110) |
| Claude Code (direct HTTP, no plugin) | Claude Code → `/mcp` over HTTP | CIMD `https://claude.ai/oauth/claude-code-client-metadata` with loopback redirect, inside a pairing window | read, write | class chat; sections as Gemini; save_floor observation (no repo key, so no repo scoping or capture) | Pair as "Claude Code (direct)"; `claude mcp add --transport http …`. The plugin is recommended instead |
| Any other MCP client | Its own route | Generic pairing (auth-and-security.md §4.4) | read, write (owner chooses) | class chat; sections as Gemini; save_floor observation | Pair; add the URL in that client |

Notes:
- **Claude desktop** uses the claude.ai connector, which syncs from the account. `mema init` never writes a stdio entry into `%APPDATA%\Claude\claude_desktop_config.json`, so tools do not appear twice.
- **Claude mobile** picks up a connector added on web or desktop at next login ([Claude custom connectors](https://support.claude.com/en/articles/11175166)).
- **ChatGPT on the phone is a goal** (owner decision). Developer Mode is documented for "the web" only ([Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)), so M0 Q01 tests both the ChatGPT phone app and chatgpt.com in the phone's browser. Each one that works gets its own row in suite X. If neither works, ADR-0019 records it as a known limitation with re-test triggers; the design does not change, because ChatGPT uses the standard path and any future mobile support needs no work on our side.
- **Gemini** connects only on the web (Developer Mode). Google documents that the app then works on mobile, but M0 did not test the phone, and in M0 only 3.1 Pro called the tools (ADR-0107). Gemini requires a personal account, US, 18+, English and Keep Activity on; asks before every write; may share data from the chat, Connected Apps and Personal Intelligence (including other people's emails) with the app ([Gemini custom apps](https://support.google.com/gemini/answer/17209137)). This is why its saves are floored to observation and its sections are narrowed.
- **Grok**: custom connectors are available to all Grok users, and the server must be publicly reachable. Grok registers by DCR, asks for every advertised scope (`memory.capture` is dropped for it), asks for no write approval, and finds the tools by search (ADR-0108).
- **Floors and sections**: the save floor follows the section allow-list (write-path.md §5). When the owner grants a client "all sections" in the admin UI (for example Grok after Q11), the UI offers to lift its save floor too; restricted clients always keep the floor.
- **Cursor web or background agents** are not a separate client in v1. If the owner wants one, it pairs as "Other" (DCR with its documented callback `https://www.cursor.com/agents/mcp/oauth/callback`, [Cursor MCP](https://cursor.com/docs/context/mcp)).
- **Enterprise accounts** of any vendor are out of scope. The README says so, and `mema init` asks the owner to confirm personal accounts only.

## 3. Coding tools

### 3.1 Common rules

- Hook trust, as documented: Codex runs non-managed hooks only after the owner trusts them in `/hooks`, and again after any change ([Codex hooks](https://learn.chatgpt.com/docs/hooks)). Claude Code runs project hooks in any folder the owner has trusted, and under `claude -p` or the Agent SDK even in a folder never trusted ([Claude Code permissions](https://code.claude.com/docs/en/permissions)). Cursor runs project hooks in any trusted workspace ([Cursor hooks](https://cursor.com/docs/agent/hooks)). memory-anywhere installs only user-level hooks and never relies on project hooks.

- Hooks call the client by absolute path: `command: "node"` with `args: ["<abs path>/memory-anywhere.mjs", "hook", "<tool>", "<event>"]` where the tool supports exec form; never `npx`, `.cmd` or `.ps1` shims. Claude Code's exec form requires `command` to resolve to a real executable ([hooks](https://code.claude.com/docs/en/hooks)).
- `mema hook …` reads JSON on stdin, never throws, always exits 0, and writes to stdout only what the table below says. Errors go to `{data}\logs\hooks.log` (no prompt text).
- Every hook first computes the repo key (topology-and-ipc.md §8). The session-start response says whether the repo is enabled and with capture; the client caches that in `{data}\cache\repos.json`. The prompt hook sends a prompt only if the cache says the repo is enabled; if the repo is not in the cache it calls `POST /v1/repos/check` with a 500 ms budget, and on any failure sends nothing. So prompts from repos that are not enabled never leave the PC. In an enabled repo, prompts are sent even with capture off, because the server needs them for 24 hours to check `user_words` (write-path.md §4); with capture off they are never extracted.
- In a repo that is not enabled, the session-start hook prints only the one-line notice (retrieval.md §8).
- Time budgets per hook invocation: session-start 1.5 s for the network (connect + TLS + response), whole hook ≤ 2.5 s, hook config timeout 5 s; prompt hook ≤ 200 ms of synchronous work (it sends asynchronously where the tool supports async hooks, otherwise it spools and returns).
- On session-start network failure the hook emits the cached context with the first line `(offline copy from <generated_at>)`.

### 3.2 Claude Code

Plugin `plugins/claude-code/` (name `memory-anywhere`; no top-level `bin/`; validated by `claude plugin validate --strict` in CI) ([plugins reference](https://code.claude.com/docs/en/plugins-reference)):

```
plugins/claude-code/
  .claude-plugin/plugin.json      {"name":"memory-anywhere","version":"<semver>","description":"Personal memory across AI apps"}
  .mcp.json                       {"mcpServers":{"memory-anywhere":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/memory-anywhere.mjs","mcp","--tool","claude-code"],"alwaysLoad":true}}}
  hooks/hooks.json                (below)
  skills/memory-anywhere/SKILL.md (memory-policy.md §6.10)
  dist/memory-anywhere.mjs        esbuild bundle of the client (pure JS)
```

`alwaysLoad` (and the tools' `_meta["anthropic/alwaysLoad"]`) keeps the tools loaded at turn 1 (ADR-0105). The plugin has no `settings.json`: Claude Code does not apply a plugin's `permissions.deny` (ADR-0110), and auth-and-security.md §6 is the boundary.

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command", "command": "node",
                     "args": ["${CLAUDE_PLUGIN_ROOT}/dist/memory-anywhere.mjs", "hook", "claude-code", "session-start"],
                     "timeout": 5 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node",
                     "args": ["${CLAUDE_PLUGIN_ROOT}/dist/memory-anywhere.mjs", "hook", "claude-code", "prompt"],
                     "async": true, "timeout": 10 } ] }
    ]
  }
}
```

| Event | Input fields used | Action | Stdout |
| --- | --- | --- | --- |
| `SessionStart` | `session_id`, `cwd`, `source`, `hook_event_name` | `POST /v1/session-start` with `max_chars: 9000`; write cache; drain spool | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<context>"}}` (≤ 9,000 chars; cap 10,000) |
| `UserPromptSubmit` | `session_id`, `cwd`, `prompt` | If repo enabled: redact; `POST /v1/writes` op `prompt` (spool on failure) | nothing (plain stdout from this hook becomes context) |

No `Stop`, `SessionEnd` or transcript reading. Capture uses only the `prompt` field (ADR-0014).

**Duplicate connector.** Connectors added on claude.ai are available in Claude Code automatically, and a local server deduplicates only against a connector at the same URL ([Claude Code MCP](https://code.claude.com/docs/en/mcp)). The plugin's stdio server and the claude.ai connector would both load. `mema init` disables the claude.ai memory-anywhere connector inside Claude Code by adding `{"serverName": "claude.ai <connector name>"}` to `deniedMcpServers` in `~/.claude/settings.json`. The name is the one the owner gave the connector on claude.ai, read from `claude mcp list`. Claude Code then prints "blocked by enterprise policy" at start-up, which `init` explains (ADR-0105). `mema doctor` fails the check `claude-code.duplicate-connector` when both appear in `claude mcp list`.

**Repo-defined shadow servers.** `mema doctor` warns when any project `.mcp.json` or Claude Code settings in a known repo defines a server whose name contains `memory-anywhere` or `mema`, or whose URL is `{host}`. `mema init` adds `"disabledMcpjsonServers": ["memory-anywhere"]` to the user-level `~/.claude/settings.json`. The key removes a project `.mcp.json` server of that name (ADR-0105).

**Evals** run Claude Code headless with explicit settings (evals.md §8).

### 3.3 Codex

Plugin `plugins/codex/` ([Codex plugins](https://developers.openai.com/codex/plugins/build.md)):

```
plugins/codex/
  .codex-plugin/plugin.json  {"name":"memory-anywhere","version":"<semver>","description":"Personal memory across AI apps",
                              "mcpServers":"./.mcp.json",
                              "hooks":{"hooks":{SessionStart → hook codex session-start; UserPromptSubmit → hook codex prompt; each with "commandWindows"}}}
  .mcp.json                  {"mcpServers":{"memory-anywhere":{"type":"stdio","command":"node","args":["<abs>/memory-anywhere.mjs","mcp","--tool","codex"]}}}
  dist/memory-anywhere.mjs
```

- Codex 0.167 loads a plugin only from `.codex-plugin/plugin.json`. A root `plugin.json` (the layout in OpenAI's plugin docs) installs but loads nothing (ADR-0110).
- `<abs>` is filled by `mema init` when it writes the local marketplace file `~/.agents/plugins/marketplace.json`.
- Installing a plugin does not trust its hooks. Untrusted hooks are skipped silently, so `init` ends by asking the owner to trust both in `/hooks` (CLI) or Settings → Hooks (desktop). Trust is again needed after any plugin change, because it is stored as a content hash ([Codex hooks](https://learn.chatgpt.com/docs/hooks)). `mema doctor` reports untrusted hooks.
- A ChatGPT custom app on the owner's account also appears in Codex as `codex_apps/memory_anywhere_*` tools. `doctor` warns when both copies are present (ADR-0110).
- The Codex IDE extension does not load plugins. For it, `mema init --clients codex` also writes `[mcp_servers.memory-anywhere]` (command `node`, args as above) into `~/.codex/config.toml` (backup + diff). The IDE then has tools but no hooks.
- The plugin bundles no skill. The standalone skill at `~/.agents/skills/memory-anywhere/SKILL.md` serves Codex and Cursor, so it appears once in each.

| Event | Input fields used | Action | Stdout |
| --- | --- | --- | --- |
| `SessionStart` | `session_id`, `cwd` | as Claude Code with `max_chars: 6000` | `additionalContext` (≤ 6,000 chars; Codex default limit 2,500 tokens) in the JSON shape Codex documents (fixture recorded in M0 Q12) |
| `UserPromptSubmit` | `session_id`, `cwd`, `prompt` | as Claude Code | nothing |

### 3.4 Cursor

- MCP and rule: the Cursor plugin `plugins/cursor/` ([Cursor plugins](https://cursor.com/docs/plugins)) holds three things:
  - `.cursor-plugin/plugin.json`;
  - `mcp.json` with the stdio server `node ${CURSOR_PLUGIN_ROOT}/dist/memory-anywhere.mjs mcp --tool cursor` (Cursor documents the variable; the M0 test used an absolute path);
  - `rules/memory-anywhere.mdc` (`alwaysApply: true`, the policy text of memory-policy.md §6.9, no memory content).

  A plugin rule applies in every workspace (ADR-0110).
- Hooks: Cursor 3.29 does not run a plugin's hooks (ADR-0110). `mema init` writes user-level `~/.cursor/hooks.json` with `"version": 1`, with backup and diff. Project hooks would need a trusted workspace, and user-level hooks avoid repo files ([Cursor hooks](https://cursor.com/docs/agent/hooks)).

| Event | Input fields used | Action | Output |
| --- | --- | --- | --- |
| `sessionStart` | common fields incl. `workspace_roots` (fixture M0 Q12; there is no `cwd`: use `workspace_roots[0]` converted from `/C:/…`, else `CURSOR_PROJECT_DIR`) | as Claude Code, `max_chars: 6000` | `{"additional_context": "<context>"}`; fire-and-forget, so recall may arrive after the first turn; it may even fire after `beforeSubmitPrompt` (ADR-0109) |
| `beforeSubmitPrompt` | `prompt` | as Claude Code prompt hook | `{"continue": true}` (never blocks) |

- Windows: the hook command is `node "<abs>memory-anywhere.mjs" hook cursor <event>`, which Cursor passes through unchanged, spaces included; no `.cmd` shim is needed. `<abs>` is the installed Cursor plugin's folder under `~/.cursor`, never `%LOCALAPPDATA%`: Cursor's hook process cannot load a script from there (ADR-0109).
- Rule: the plugin's `rules/memory-anywhere.mdc` carries the policy text to every workspace, so the client writes no rule file into any repository (ADR-0110). Cursor's server instructions: see ADR-0104.

### 3.5 Generic coding harness

Any MCP client that can launch a stdio server can run `mema mcp --tool generic`. It gets the PC grant, tools, the offline behaviour of topology-and-ipc.md §5, and no hooks. `MA-Tool: generic` is accepted.

## 4. Chat apps

### 4.1 Connection steps (owner)

1. On the PC or phone, open `https://admin.{host}` → **Connect a new app** → choose the vendor. This opens a pairing window of 10 minutes (auth-and-security.md §4.1), binds it to that browser, and shows the values to paste and the 8-character pair code. If the vendor's sign-in opens in a different browser, the consent page asks for that code.
2. In the vendor app, add the connector with URL `https://{host}/mcp` and, for static methods, the client id and secret the admin UI shows.
3. Complete the vendor's OAuth flow: the consent page shows the vendor host, the exact redirect URI and the registration time, and requires a passkey.
4. In the vendor app, run "What does memory_status say?" The admin UI shows the grant as connected.
5. Paste the custom instruction (memory-policy.md §6.11) where the app supports one. `mema init --print-custom-instruction` prints each app's path and limit (ADR-0104). Gemini gets its own plain wording, because it refuses text that names tools. Grok needs none.

Claude only: there is no per-connector loading mode. "Connectors in new chats" (Settings → Capabilities → Advanced) is account-wide: "Only when a chat needs them" (the default) or "At the start of every chat". The default is kept, because the custom instruction alone makes Claude save and recall unprompted. Per connector, only Tool permissions exist (Needs approval / Always allow / Blocked) (ADR-0103).

### 4.2 Approval friction (documented, accepted)

| Client | Write approvals |
| --- | --- |
| Claude | Read-only tools vs write tools are grouped for allow settings; `memory_save` is not destructive, `memory_forget` is (prompts every time) |
| ChatGPT | Tools without `readOnlyHint` need approval once per conversation |
| Gemini | An approval card for every tool call, reads included (ADR-0107) |
| Grok | None: saves and recalls run without approval (ADR-0108) |

An MCP Apps guided-save widget is out of scope for v1.

### 4.3 After a policy release

`tools/list` changes only with a policy version. ChatGPT and Gemini keep old descriptions until the connector is refreshed. `mema doctor --policy` prints, per vendor, the refresh steps recorded in M0, and the admin UI flags clients whose reported `policy_version` lags.

## 5. Caches (no projection files in v1)

No memory content is written outside `{data}`. Coding tools get memory at session start from the session-start hook, which emits the cached context when offline. Optional user-level projection files (a Claude Code rules file, a Codex `AGENTS.md` block) are deferred until the session-start hook proves insufficient in use (ADR-0009, ADR-0023).

| Item | Path | Content | Written by |
| --- | --- | --- | --- |
| Profile cache | `{data}\cache\profile.md` | Rendered profile (retrieval.md §7) | every session-start and `mema sync` |
| Repo context cache | `{data}\cache\repo-<repo_key>.md` | Session-start context for that repo | session-start, `mema sync` (enabled repos only) |
| Repo state cache | `{data}\cache\repos.json` | Enabled and capture flags per repo key | session-start, `/v1/repos/check` |
| Tools cache | `{data}\cache\tools.json` | Last `tools/list` | proxy |

Rules:
- Never write inside Claude Code's `autoMemoryDirectory` (which relocates Claude's own auto memory; [memory](https://code.claude.com/docs/en/memory)).
- The client writes no file inside any repository. The Cursor rule travels in the Cursor plugin (§3.4, ADR-0110).
- Importers skip any file carrying a memory-anywhere marker (`generated by memory-anywhere`).

## 6. Install and doctor

`mema init` (config-and-cli.md §3) does, in order: confirm personal accounts; `mema connect` and `mema login`; detect installed tools; install plugins (Claude Code: `claude plugin marketplace add <dir>` then `claude plugin install memory-anywhere@memory-anywhere --scope user`; Codex: local marketplace, then the owner trusts the hooks; Cursor: copy the plugin to `~/.cursor/plugins/local/memory-anywhere/`, write `~/.cursor/hooks.json`, then ask the owner to run Developer: Reload Window), backing up every file it changes as `<file>.ma-bak-<timestamp>` and printing a unified diff first (`--dry-run` stops there); write the standalone skill; ask for the repo deny-list; optionally register the sync task; print the custom instruction; run `doctor`.

`mema doctor` checks, each with pass/warn/fail and a fix line:

| Check id | Pass when |
| --- | --- |
| `store.reachable` | `/v1/health` ok within 2 s |
| `dns` | `{host}` and `admin.{host}` resolve to the same address, which is not a Cloudflare proxy address (aws mode) |
| `store.version` | client version supported |
| `auth.pc-grant` | token refresh works |
| `claude-code.plugin` | plugin installed and enabled at user scope |
| `claude-code.hooks` | both hooks present and pointing at the current bundle |
| `claude-code.duplicate-connector` | memory-anywhere tools appear once |
| `codex.plugin`, `codex.hooks-trusted` | plugin installed; hooks trusted |
| `cursor.plugin`, `cursor.hooks` | plugin present in `~/.cursor/plugins/local/`; both hooks present and pointing at the plugin's bundle |
| `skill.single` | the skill exists once across `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills` |
| `shadow-servers` | no repo config defines a memory-anywhere-like server |
| `foreign-hooks` | no user or known-repo hook config mentions `mema`/`memory-anywhere` except the ones this client installed |
| `repos.enabled` | lists enabled repos and the deny-list |
| `spool` | below 80% of limits |
| `caches` | caches fresh (< 24 h) |
| `policy` | each chat client's reported policy version is current |
