# 0114 Cursor in M1: context and capture work, tool calls do not find the repo

Status: accepted (Cursor's M1 claim is session-start context and prompt capture; its tool calls are a known limitation)
Date: 2026-11-11
Milestone: M1

## Context
The M1 gate asks, for each coding tool, that a session in an enabled repo gets session-start context, saves with an outcome, and
recalls in a new session, "or an ADR says why not". Claude Code and Codex pass ([M1.md](../results/M1.md) §1). This ADR is the
"why not" for Cursor.

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

## Method
Cursor 3.29.9, Windows 11, the plugin and hooks installed by `mema init --local --from-workspace`, the enabled test repo
`test repo` (a space in its path). The owner typed the chats; each attempt reloaded the window and opened a new chat. Option 1 was
also checked outside Cursor with a probe that starts the installed bundle exactly as Cursor's `mcp.json` does.

## Result
Full record: [cursor-sessions.md](../results/evidence/M1/cursor-sessions.md).
- **Session-start context: works.** The agent quoted the block's first line, "memory-anywhere is active for this repository
  (policy P1)."
- **Prompt hook: works** (the same hooks write `cursor-active.json`, which holds the test repo's key).
- **Tool calls: fail.** With option 1 in place, `memory_save` still answered "not enabled for this repository" in three chats.
  The second attempt also exposed that Cursor checks an error result's `structuredContent` against the output schema; errors
  now carry the Error object in `_meta` (spec-issues #50), which is fixed and kept.
- **The probe passes:** started from the home folder with no workspace, the installed bundle reads the hooks' file and acts for
  the test repo.
- **No diagnosis yet.** The proxy logs one `proxy.repo` line per call to `{data}\logs\client.log`; after the owner's last two
  chats that file does not exist. So no proxy running the current bundle handled those calls. The likely cause is that Cursor
  kept an MCP process started before the bundle was replaced, because a window reload does not restart a plugin's MCP server.
  This is unverified.

## Decision
Option 1 stays (it is correct in the probe and harmless elsewhere), together with the `proxy.repo` log line. M1 claims for Cursor
only what was observed: session-start context and prompt capture. Saving and recalling from Cursor's agent is a known limitation
of M1, documented in [M1.md](../results/M1.md) §4. Per the owner (2026-11-11), M1 does not spend more time on it.

Re-test at the start of M2: quit Cursor completely (so the plugin's MCP process restarts), open the test repo, save and recall in
two chats, then read `client.log`. If the lines show `source: "cursor-hook"` with the test repo, the gate item passes. If they
show `start-folder`, the hooks' file is not being read and option 3 is next. If there are still no lines, Cursor is not running
this bundle, and the plugin install path is what to check.

## Consequences
- Cursor users get their memory in every chat's context, and their prompts are captured, but the agent cannot save on request.
  The plugin's rule still tells the agent to use the tools, so a save attempt in Cursor ends in a visible refusal, not silence.
- `negative-results.md` records options 1–2 as failed in Cursor.
- No spec section changes; spec-issues #49 and #50 already describe the implemented design.
