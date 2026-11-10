# Q13 Plugins on Windows, 2026-11-09 (UTC)

## Claude Code 2.1.319
- A plugin loaded with `--plugin-dir` (path with spaces) brings its MCP server (`plugin:memory-anywhere:memory-anywhere`, connected)
  and its hooks (3/3 canary, see ADR-0109).
- A plugin's `settings.json` `permissions.deny` is **not** applied: `Bash(echo q13-denied*)` ran with and without it, with no
  permission denial. Evidence: [../ADR-0105/claude-code-q07-q12-q13-q17.json](../ADR-0105/claude-code-q07-q12-q13-q17.json)
  (`q13_plugin_settings_deny`).

## Codex CLI 0.167.0 (and the Codex desktop app 26.1103 for the trust step)
`codex features list` shows `plugins stable true` and `plugin_hooks removed false`. The flag is gone, but plugin hooks still run
(below).

### Plugin as built
The local marketplace lived in a folder with a space. The **Codex CLI** used `.codex-plugin/plugin.json`; the newer root
`plugin.json` was ignored.

| File | Content |
| --- | --- |
| `<market>\.agents\plugins\marketplace.json` | `{"name":"ma-m0-local","plugins":[{"name":"memory-anywhere","source":{"source":"local","path":"./plugins/memory-anywhere"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}` |
| `plugins\memory-anywhere\.codex-plugin\plugin.json` | `{"name","version","description","mcpServers":"./.mcp.json","hooks":{"hooks":{SessionStart…,UserPromptSubmit…}}}` |
| `plugins\memory-anywhere\.mcp.json` | `{"mcpServers":{"memory-anywhere":{"type":"stdio","command":"node","args":["<repo>\\spikes\\stub-server\\src\\main.ts","stdio"],"default_tools_approval_mode":"approve"}}}` |

Install: `codex plugin marketplace add "<market>"`, then `codex plugin add memory-anywhere@ma-m0-local`. Codex copies the plugin to
`~/.codex/plugins/cache/ma-m0-local/memory-anywhere/<version>/` and adds `[plugins."memory-anywhere@ma-m0-local"] enabled = true`
to `config.toml`.

### Runs (`codex exec --json`, from a working folder with a space)
| # | Plugin manifest | Result |
| --- | --- | --- |
| 1 | root `plugin.json` + `mcp.json` + `hooks/hooks.json` (the layout in OpenAI's plugin docs) | Install succeeded, but Codex synthesised `.codex-plugin/plugin.json` with only `name` and `category`. **No MCP server, no hooks.** The model fell back to `codex_apps/memory_anywhere.memory_status`, which failed: "MCP tool call requires approval, but approval policy is never". |
| 2 | same, with `default_tools_approval_mode` | Same: the stdio server was not exposed. |
| 3 | `.codex-plugin/plugin.json` with `mcpServers` and inline `hooks` | **MCP loaded**: `memory-anywhere/memory_status` ran without an approval prompt and returned the stub status. The plugin hooks were **skipped without any message** (not yet trusted). |
| 4–6 | same, after the owner trusted the two plugin hooks in Codex desktop Settings → Hooks | Plugin hooks fired 3/3. Trust is stored as `[hooks.state."memory-anywhere@ma-m0-local:plugin.json#hooks[0]:session_start:0:0"] trusted_hash = "sha256:…"`. Canary 3/3. |
| 7 | same, with the user-level `~/.codex/hooks.json` moved away | Canary `HOOK-CANARY-5RJ8`, so it came from the plugin hook alone. That hook printed **plain text**, not the JSON shape, so Codex accepts plain stdout as SessionStart context. |

### Side finding: ChatGPT apps appear in Codex
The owner's ChatGPT custom MCP apps ("memory-anywhere spike" and "memory-anywhere") show up in Codex as `codex_apps/memory_anywhere_*`
and `codex_apps/memory_anywhere_spike_*` tools. That is the same remote server reaching Codex a second time, through the ChatGPT
account, and each call needs approval (it fails under `codex exec`'s `never` policy). `mema init --clients codex` must account for
it (see ADR-0110).

## Cursor 3.29.9
### Plugin as built
A local plugin at `~/.cursor/plugins/local/memory-anywhere/`, laid out like Cursor's `plugin-template` (`starter-advanced`). The
user-level `~/.cursor/hooks.json` was moved away for these runs, so any hook must come from the plugin.

| File | Content |
| --- | --- |
| `.cursor-plugin/plugin.json` | `{"name":"memory-anywhere","displayName","version","description"}` |
| `mcp.json` | `{"mcpServers":{"memory-anywhere":{"command":"node","args":["<repo>\\spikes\\stub-server\\src\\main.ts","stdio"]}}}` |
| `hooks/hooks.json` | `{"hooks":{"sessionStart":[{"command":…}],"beforeSubmitPrompt":[{"command":…}]}}` (format from Cursor's plugin reference) |
| `rules/memory-anywhere.mdc` | front matter `alwaysApply: true`; body "if asked for the memory-anywhere rule canary, reply exactly RULE-CANARY-7M3T." |

The owner ran Developer: Reload Window, then a new Agent chat for each run.

### Runs
| # | Workspace | Hook commands | Reply |
| --- | --- | --- | --- |
| 1 | `cursor q12 ws` | `node ./record.mjs cursor-plugin <event>` | `NONE` · `RULE-CANARY-7M3T` · `{"store":"m0-stub","healthy":true,…}` |
| 2 | `cursor q13 ws2` (never opened before) | same | same three lines |
| 3 | `cursor q12 ws` | absolute: `node "C:\…\plugins\local\memory-anywhere\record.mjs" …` and `node "${CURSOR_PLUGIN_ROOT}/record.mjs" …` | `NONE` |

- **MCP:** the plugin's stdio server loaded, and `memory_status` returned in both workspaces with no approval prompt reported.
- **Rule:** an `alwaysApply` plugin rule reached the model in both workspaces, including one with no `.cursor/` folder. So a
  plugin rule applies in every workspace.
- **Hooks:** the plugin's hooks never ran. Cursor's Hooks output channel logged "No user hooks configuration found" and only
  `workspaceOpen` steps, never `sessionStart` or `beforeSubmitPrompt`. The recorder wrote nothing. Changing to absolute paths
  (run 3) changed nothing. Local plugins in Cursor 3.29.9 do not contribute hooks.
- **Side finding:** at start-up Cursor's hook service also lists Claude Code's hook files: `~/.claude/settings.json`, and each
  workspace's `.claude/settings.json` and `.claude/settings.local.json`. A Claude Code hook installed by `mema init` may therefore
  also be loaded by Cursor (to be checked in M1 with the real hooks; the client must ignore a Claude-Code-shaped call that
  arrives with Cursor's `cursor_version` field).
