# 0114 Cursor: the proxy must find the chat's repo

Status: accepted (hooks tell the proxy the repo, and the Claude Code plugin's proxy recognises Cursor as its host)
Date: 2026-11-11
Milestone: M1

## Context
The M1 gate asks, for each coding tool, that a session in an enabled repo gets session-start context, saves with an outcome, and
recalls in a new session, "or an ADR says why not". Claude Code and Codex pass ([M1.md](../results/M1.md) §1). Cursor's context
and capture worked from the start, but its tool calls did not; this ADR records why, and the fix.

Two pieces of memory-anywhere run inside a coding tool, and they learn the repo differently:
- **Hooks** run once per event (session start, each prompt). Cursor hands every hook a JSON object that includes
  `workspace_roots`, so a hook always knows the repo.
- **The MCP proxy** (`mema mcp --tool cursor`) is one long-running process that carries the model's tool calls (`memory_save`,
  `memory_recall`) to the server. It must work out the repo itself, and the server refuses repo-scoped work for a repo that is
  not enabled.

In Claude Code and Codex the proxy is started per project, so `CLAUDE_PROJECT_DIR` or its working folder names the repo
(spec-issues #28). Cursor 3.29.9 starts **one** plugin MCP process for all its windows, from the home folder, with no project
variable (spec-issues #49). The proxy therefore sees no repo, answers for "none", and every save is refused as "not enabled for
this repository".

## Options
1. **Hooks tell the proxy.** The `sessionStart` and `beforeSubmitPrompt` hooks write the repo to `{data}\cache\cursor-active.json`;
   the Cursor proxy reads it on each call (if under 12 hours old) and reconnects when it changes. No Cursor setting needed; with
   several windows open, the last prompt wins.
2. **`${workspaceFolder}` in the plugin's `mcp.json`** (as `MA_REPO_DIR`). Tried in M1 and reverted: the shared plugin process
   still did not carry the workspace.
3. **A per-project MCP entry** (`.cursor/mcp.json` written by `mema enable`), which Cursor starts in the workspace. Not tried;
   it writes a file into every enabled repo, which clients.md §3.4 avoids, and duplicates the plugin's server.
4. **Ship Cursor without tool calls in M1** and say so.
5. **The proxy recognises its host** (found after the diagnosis below). A proxy started as `claude-code` without `CLAUDECODE=1`
   and with Cursor's environment serves as the Cursor proxy (option 1's repo source). It works whichever of the two colliding
   servers Cursor keeps, and needs no Cursor setting: Cursor's only switch for imports is all-or-nothing and would also drop
   the owner's other imported skills and rules.

## Method
Cursor 3.29.9, Windows 11, the plugin and hooks installed by `mema init --local --from-workspace`, the enabled test repo
`test repo` (a space in its path). The owner typed the chats; each attempt reloaded the window and opened a new chat. The
diagnosis read Cursor's own logs (`%APPDATA%\Cursor\logs`), the running processes' command lines and parents, and the names of
their environment variables (read from each process; values printed only for path variables). Probes start the installed bundles
from the home folder, as Cursor does.

## Result
Full record: [cursor-sessions.md](../results/evidence/M1/cursor-sessions.md).
- **Session-start context: works.** The agent quoted the block's first line, "memory-anywhere is active for this repository
  (policy P1)."
- **Prompt hook: works** (the same hooks write `cursor-active.json`, which holds the test repo's key).
- **Tool calls: failed.** With option 1 in place, `memory_save` still answered "not enabled for this repository" in three chats,
  although a probe of the Cursor plugin's bundle acted for the test repo.
  The second attempt also exposed that Cursor checks an error result's `structuredContent` against the output schema; errors
  now carry the Error object in `_meta` (spec-issues #50), which is fixed and kept.
- **The probe passes:** started from the home folder with no workspace, the installed bundle reads the hooks' file and acts for
  the test repo.
- **Diagnosis (2026-11-11): Cursor was not running the Cursor plugin's proxy at all.** No process had `--tool cursor` on its
  command line. Cursor's only memory-anywhere MCP process was `node …\.claude\plugins\cache\memory-anywhere\…\memory-anywhere.mjs
  mcp --tool claude-code`, whose parent is Cursor's node service. Cursor's plugin log shows why: it loads both
  `loadUserLocalPlugin memory-anywhere` and `loadClaudePlugin memory-anywhere@memory-anywhere` (Cursor imports Claude Code
  plugins by default). Both plugins name their server `memory-anywhere`, so they get the same id,
  `plugin-memory-anywhere-memory-anywhere`, and the Claude Code one wins. A `claude-code` proxy never reads the Cursor hooks' file
  and, under Cursor, has no `CLAUDE_PROJECT_DIR`, so it acted for `none`. Cursor runs only the two hooks in
  `~/.cursor/hooks.json`, not the Claude Code plugin's hooks, which is why context and capture were never affected.
- **The two hosts' environments differ in one reliable way.** Read from the running processes: Claude Code sets
  `CLAUDECODE=1`, `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT` for its MCP servers. Cursor sets none of them; it sets
  `WORKSPACE_FOLDER_PATHS` (the first window's folder only, a different repo here) and `VSCODE_CWD=C:\Program Files\cursor`.

## Decision
Options 1 and 5 together (spec-issues #49, #51), with the `proxy.repo` log line, which now records `tool: "cursor"` for
either server. A probe that starts the installed Claude Code bundle exactly as Cursor does (`--tool claude-code`, home folder,
Cursor's environment) after a Cursor prompt hook for the test repo reports `repo_enabled: true`; before the fix the same probe
reported `false`.

The gate item passes when a real Cursor session does the same: quit Cursor completely (its running proxy predates the fix), open
the test repo, save in one chat and recall in a new one, then check `client.log` for `tool: "cursor"`,
`source: "cursor-hook"` and the test repo's key. [M1.md](../results/M1.md) records the outcome.

## Consequences
- Both plugins stay installed: the Cursor plugin carries the rule and is what Cursor runs if the owner turns imports off; the
  Claude Code plugin is what Cursor runs while imports are on. Either way the proxy serves Cursor.
- If Cursor ever sets `CLAUDECODE` for imported servers, or drops `WORKSPACE_FOLDER_PATHS` and `VSCODE_CWD`, the proxy acts for
  `none` again and saves are refused visibly; the `proxy.repo` log line shows which tool it decided on. Re-check on each
  Cursor release, with the Cursor hook fixtures.
- `negative-results.md` records the first two attempts and the misdiagnosis.
- topology-and-ipc.md §5 describes the repo source for all three tools.
