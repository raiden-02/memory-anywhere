# 0109 Coding-tool hooks on Windows

Status: accepted
Date: 2026-11-09
Milestone: M0
Question: Q12

## Context
Capture and session-start recall in the coding tools depend on hooks (clients.md §3, ADR-0014). clients.md §3 names the events and
input fields for each tool from the vendors' docs. Two points were open:
- whether the documented payloads match what each tool actually sends on Windows;
- whether Cursor, which documents running hooks through PowerShell and appending `.ps1` to bare script names, passes a
  `node "<abs>" …` command line through unchanged. If not, the fallback was a `.cmd` shim.

## Options
1. Use the hooks as specified in clients.md §3, with field mappings taken from recorded fixtures.
2. Fall back per tool: a `.cmd` shim for Cursor, adjusted field mappings, and no capture for a tool without a prompt hook.

## Method
- **Platform:** Windows 11 Home 10.0.26200, Node 24.22.2.
- **Tool versions:** Claude Code 2.1.319, Codex CLI 0.167.0 (hooks trusted in Codex desktop 26.1103), Cursor 3.29.9.
- **Recorder:** `spikes/hook-recorder/record.mjs` ran as each tool's hook, from paths with spaces. It recorded stdin, argv, cwd and
  the environment variable names. On session start it printed a canary context in the tool's documented output shape.
- **Sessions:** three per tool, each asked "If you were given a memory-anywhere hook canary, reply with it exactly; otherwise
  reply NONE."
- **Headless flags:** `--setting-sources` and `--strict-mcp-config` were checked in Claude Code.

## Result
- **Evidence:** [`docs/results/evidence/ADR-0109/q12-hooks-windows.md`](../results/evidence/ADR-0109/q12-hooks-windows.md).
- **Fixtures:** `evals/fixtures/hooks/{claude-code/2.1.319, codex/0.167.0, cursor/3.29.9}/`.

| Tool | Events fired | Context reached the model | Notes |
| --- | --- | --- | --- |
| Claude Code | `SessionStart`, `UserPromptSubmit` | 3/3 | `--strict-mcp-config` with an empty config removes every MCP server; `--setting-sources ""` drops user servers but keeps plugin and claude.ai ones |
| Codex | `SessionStart`, `UserPromptSubmit` (`commandWindows`) | 3/3 after trust; 0 before | Untrusted hooks are skipped with no message. Trust is a SHA-256 per hook in `config.toml`, so any change needs a new trust |
| Cursor | `sessionStart`, `beforeSubmitPrompt` | 2/2 once the script was outside `%LOCALAPPDATA%` | `node "<abs>"` passes through unchanged, a path with a space works, and no `.ps1` rule applies. A script **under `%LOCALAPPDATA%`** fails with `MODULE_NOT_FOUND`, with or without a space in its path |

- **Field names match clients.md §3.** Claude Code and Codex send `session_id`, `cwd` and `prompt`; Cursor sends `prompt` and
  `workspace_roots`.
- **Cursor has no `cwd`.** Its `workspace_roots` entries are URL-style (`/C:/Users/…`).
- **Cursor's event order varies.** In some sessions `beforeSubmitPrompt` fired about 2 s before `sessionStart`.
- **Codex also accepts plain stdout.** A plain-text `SessionStart` stdout reached the model as well as the JSON shape
  (ADR-0110 evidence, run 7).

## Decision
**Use the hooks as specified** (option 1), with three precise changes to clients.md §3:
1. **Cursor hook command:** `node "<abs>\memory-anywhere.mjs" hook cursor <event>`. The `.cmd` shim is dropped. `<abs>` must not
   be under `%LOCALAPPDATA%`. The bundle the Cursor hooks call lives in the Cursor plugin's install folder under `~/.cursor/`
   (ADR-0110).
2. **Cursor working folder:** `cwd` = `workspace_roots[0]`, converted from `/C:/…` to a native path, falling back to
   `CURSOR_PROJECT_DIR`. The client must not assume `sessionStart` runs before `beforeSubmitPrompt`. It already treats
   `sessionStart` as fire-and-forget; a prompt arriving first is captured normally.
3. **Codex trust:** `mema doctor` reports untrusted Codex hooks, as already specified. M0 adds that untrusted hooks fail
   *silently*, so `mema init --clients codex` ends by telling the owner to trust the hooks in `/hooks` (CLI) or Settings → Hooks
   (desktop).

The `packages/client/src/hooks/<tool>.ts` field mappings are written in M1 against the committed fixtures.

## Consequences
- No shim file is needed on Windows.
- The Cursor bundle location is now a constraint: an install under `%LOCALAPPDATA%` (the data directory) cannot host it.
- The cause of Cursor's `%LOCALAPPDATA%` failure is unknown. The same hook process can *write* there, so it looks like a read
  restriction in Cursor's hook runner. It is recorded in negative-results.md, with a re-test whenever Cursor's version changes.
- Every Codex hook change needs the owner's trust again.
