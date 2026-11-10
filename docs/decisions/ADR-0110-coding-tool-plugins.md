# 0110 Coding-tool plugins

Status: accepted (Claude Code and Codex plugins ship; Cursor uses a plugin plus `init`-written hooks)
Date: 2026-11-09
Milestone: M0
Question: Q13

## Context
clients.md §3 plans one plugin per coding tool, each bundling the stdio MCP server, the hooks and the client bundle. That raises
three questions:
- **Codex:** does a locally installed plugin load both MCP and hooks?
- **Cursor:** does a plugin carry MCP, hooks and rules, and does a plugin rule apply in every workspace? clients.md §3.4 writes
  `.cursor/rules/memory-anywhere.mdc` into each enabled repo unless it does.
- **Claude Code:** is a plugin's `settings.json` `permissions.deny` applied?

If a plugin does not load, the fallback (m0-spike.md Q13) is that `mema init` writes the tool's config files with backup and diff.

## Options
1. Ship a plugin per tool, carrying everything it loads.
2. Have `mema init` write each tool's user config files (MCP, hooks) with backup and diff.
3. Mix the two per tool, according to what each tool's plugin actually loads.

## Method
- **Platform:** Windows 11 Home 10.0.26200.
- **Tool versions:** Claude Code 2.1.319, Codex CLI 0.167.0 (trust step in Codex desktop 26.1103), Cursor 3.29.9.
- **Plugins:** minimal plugins with the M0 stub over stdio and the hook recorder.
  - Codex: installed from a local marketplace in a folder with a space (`codex plugin marketplace add`, `codex plugin add`).
  - Cursor: a local plugin in `~/.cursor/plugins/local/`.
  - Claude Code: loaded with `--plugin-dir`.
- **Isolation:** the user-level hook files were moved away for the attribution runs. All test plugins, hook files and trust
  entries were removed afterwards.

## Result
Evidence: [`docs/results/evidence/ADR-0110/q13-plugins.md`](../results/evidence/ADR-0110/q13-plugins.md) and
[`../ADR-0105/claude-code-q07-q12-q13-q17.json`](../results/evidence/ADR-0105/claude-code-q07-q12-q13-q17.json).

| Tool | MCP from the plugin | Hooks from the plugin | Rule from the plugin | Other |
| --- | --- | --- | --- | --- |
| Claude Code | yes | yes (3/3) | n/a | plugin `settings.json` `permissions.deny` **not applied** (the denied Bash command ran) |
| Codex | yes, only with the legacy `.codex-plugin/plugin.json` manifest | yes, after the owner trusts them (3/3), with no message while untrusted | n/a | The documented root `plugin.json` layout installed but loaded nothing. Trust is stored per plugin hook with a content hash |
| Cursor | yes, no approval prompt | **no**: never run, with relative or absolute commands | **yes**: an `alwaysApply` rule reached the model in a workspace Cursor had never opened | Cursor's hook service also lists Claude Code's settings files as hook sources |

**Side finding.** The owner's ChatGPT custom MCP apps appear in Codex as `codex_apps/memory_anywhere_*` tools. Each call needs
approval. That makes a second copy of the remote server next to the plugin's local one.

## Decision
Option 3:
- **Claude Code: ship the plugin.** Drop the plugin's `settings.json` deny list: it is not applied, and auth-and-security.md §6
  stays the boundary. Keep `alwaysLoad` (ADR-0105).
- **Codex: ship the plugin, in the layout Codex 0.167 loads.** That is `.codex-plugin/plugin.json` with
  `"mcpServers": "./.mcp.json"` and the hooks inline under `"hooks"`, plus `.mcp.json` and `dist/memory-anywhere.mjs`.
  - `default_tools_approval_mode: "approve"` stays off. Approval is the owner's choice, set in Codex.
  - `mema init --clients codex` writes the local marketplace and ends by telling the owner to trust the two hooks.
  - `mema doctor` reports hooks that are untrusted or whose trust no longer matches.
  - The `~/.codex/config.toml` entry for the IDE extension stays as specified.
- **Cursor: plugin for MCP and the rule; `init` writes the hooks.** The plugin carries the stdio MCP server and
  `rules/memory-anywhere.mdc` (`alwaysApply: true`, the policy text of memory-policy.md §6.9). No rule file is written into any
  repo, and the `.git/info/exclude` step in clients.md §3.4 is dropped.
  - `mema init --clients cursor` writes user-level `~/.cursor/hooks.json` (`"version": 1`), with backup and diff.
  - The hook commands point at `dist/memory-anywhere.mjs` inside the installed Cursor plugin, a path under `~/.cursor`
    (ADR-0109: not `%LOCALAPPDATA%`).
- **Duplicates:**
  - `mema doctor` warns when Codex shows both the plugin server and `codex_apps/memory_anywhere*` tools. The owner can hide the
    ChatGPT copy with Codex's app settings.
  - `doctor` will also check in M1 whether Cursor runs Claude Code's user hooks. If it does, the client ignores a Claude Code hook
    call whose payload carries `cursor_version`.

clients.md §3.2–§3.4 change accordingly.

## Consequences
- **Claude Code and Codex** install with one step each, plus the one-time Codex hook trust.
- **Cursor** needs the plugin plus a user file written by `init`. If Cursor later loads plugin hooks, the hooks move into the
  plugin and `init` stops writing `hooks.json`. Re-test whenever `cursor_version` changes.
- **The Claude Code deny list is gone.** It was defence in depth only.
- **Codex's documented plugin layout did not load**, and the legacy layout did. Re-test both on each Codex release, because the
  legacy manifest may be removed. Recorded in negative-results.md.
