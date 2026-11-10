# 0105 Claude Code: tool loading and the duplicate claude.ai connector

Status: accepted
Date: 2026-11-09
Milestone: M0
Question: Q07, Q17

## Context
- **Q07.** Claude Code defers MCP tools behind tool search, so the memory tools may not be in context at turn 1.
  clients.md §3.2 sets `alwaysLoad: true` on the plugin's server, and mcp-interface.md also puts `_meta["anthropic/alwaysLoad"]`
  on the tools. These are kept only if Claude Code honours them.
- **Q17.** A connector added on claude.ai also appears in Claude Code. With the plugin installed, the same memory would load
  twice. `mema init` must disable only the claude.ai copy inside Claude Code, and should disable repo-defined shadow servers with
  `disabledMcpjsonServers` if that key exists at user level.

## Options
- **Q07:** keep the flags, or drop them and rely on server instructions, the skill and the session-start preamble.
- **Q17:** a per-connector switch; or `disableClaudeAiConnectors`, which turns off *all* claude.ai connectors, after asking the
  owner; or a `doctor` warning only.

## Method
- **Environment:** Claude Code 2.1.319 on Windows 11, headless (`claude -p … --output-format stream-json --verbose`), model
  claude-haiku-5-5.
- **Q07:** the stub plugin was loaded with `--plugin-dir`, with `ENABLE_TOOL_SEARCH` set to `true` and to `auto`, in three
  variants: no flag, `.mcp.json` `alwaysLoad`, and tool `_meta["anthropic/alwaysLoad"]`. Each run was read for a ToolSearch call
  before the memory tool.
- **Q17:** the spike connector was added on claude.ai. Each candidate setting was passed with `--settings` and in a project
  `.claude/settings.json`, and `mcp_servers` was read from the `system/init` event.

## Result
Evidence:
- [`claude-code-q07-q12-q13-q17.json`](../results/evidence/ADR-0105/claude-code-q07-q12-q13-q17.json)
- [`q17-claudeai-connector.md`](../results/evidence/ADR-0105/q17-claudeai-connector.md)

| Q07 variant | `ENABLE_TOOL_SEARCH=true` | `auto` |
| --- | --- | --- |
| no flag | deferred (ToolSearch first) | deferred |
| `.mcp.json` `alwaysLoad: true` | loaded at turn 1 | loaded at turn 1 |
| tool `_meta["anthropic/alwaysLoad"]` | loaded at turn 1 | loaded at turn 1 |

| Q17 setting | claude.ai memory-anywhere connector in Claude Code |
| --- | --- |
| `disabledMcpjsonServers: ["claude.ai memory-anywhere"]` | still loaded |
| `disabledMcpServers: […]` | still loaded |
| `deniedMcpServers: [{"serverName":"claude.ai memory-anywhere"}]` (`--settings` or a settings file) | **removed**; the other claude.ai connectors stay. Warning: "claude.ai MCP server blocked by enterprise policy" |
| `disabledMcpjsonServers: ["memory-anywhere"]` against a project `.mcp.json` server | the project server is removed |

## Decision
- **Q07: keep both flags.** Each one alone keeps the tools loaded at turn 1.
- **Q17:**
  - `mema init` adds `{"serverName": "claude.ai <connector name>"}` to `deniedMcpServers` in `~/.claude/settings.json`, with
    backup and diff. The connector name is whatever the owner typed on claude.ai, so `init` reads it from `claude mcp list`.
  - `disableClaudeAiConnectors` is not used.
  - `"disabledMcpjsonServers": ["memory-anywhere"]` is added at user level as clients.md §3.2 specifies; the key exists and works.
  - `mema doctor` still fails `claude-code.duplicate-connector` if both copies appear.
- clients.md §3.2 is updated to name the `deniedMcpServers` mechanism.

## Consequences
- **`init` explains the warning.** The "enterprise policy" warning appears on every Claude Code start-up, so `init` tells the
  owner it is expected.
- **Renamed connector.** If the owner renames the connector on claude.ai, the deny entry stops matching. `doctor` catches this
  because both copies then appear.
- **claude.ai drops server instructions.** Through the claude.ai connector, server instructions do not reach the model, while the
  stdio plugin's do (ADR-0104). Disabling the connector inside Claude Code is therefore also the better-informed choice.
