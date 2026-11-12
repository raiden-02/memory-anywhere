# Cursor sessions on the owner's PC (M1 gate, 2026-11-10)

Cursor 3.29.9 on Windows 11, plugin installed by `mema init --local --from-workspace`, in the enabled test repo `test repo`
(a space in its path). The owner typed each chat; the replies below are copied from Cursor's chat panel.

## Session start

Asked for the first sentence of its memory context, Cursor's agent answered with the session-start block's first line:

> memory-anywhere is active for this repository (policy P1).

So the `sessionStart` hook ran, reached the local server, and Cursor added the returned context to the chat.

## Save, attempt 1 (bundle from commit `d54b9a3`)

Prompt: "Remember that I always write commit messages in the imperative mood."

> NONE memory-anywhere is not enabled for this repository, so the preference that you always write commit messages in the
> imperative mood was not stored.

The proxy computed the repo from its own environment. Cursor runs one plugin MCP process for all windows and gives it neither a
project variable nor the workspace as its working folder, so the repo key was "none" (spec-issues #49).

## Save, attempt 2 (bundle from commit `33eb145`: the repo comes from the hooks' `cursor-active.json`)

Same prompt, in a new chat after reloading the window:

> memory-anywhere is active for this repository (policy P1). I tried to save that you always write commit messages in the
> imperative mood, but the tool response did not match its schema, and a lookup says memory-anywhere is not enabled for this
> repository, so the preference was not stored.

Two failures: the save still acted for "none", and Cursor rejected the error result because it checks `structuredContent`
against the tool's output schema even when `isError` is true (fixed in the same commit's server half, spec-issues #50).

## Attempt 3 (bundle from commit `1adceb0`, which logs each repo decision)

The owner ran two more chats ("Chats done"). The save still reported the repo as not enabled. `{data}\logs\client.log`, where
the proxy writes one `proxy.repo` line per call, does not exist on the PC: no proxy process running this bundle handled a tool
call. The installed bundle (`~/.cursor/plugins/local/memory-anywhere/dist/memory-anywhere.mjs`, written 18:24) does contain the
logging and the `cursor-active.json` read.

## Diagnosis (2026-11-11)

Cursor (started 16:24) had no process with `--tool cursor`. Its only memory-anywhere MCP process:

```
node.exe    pid 30808  16:29:50  node %USERPROFILE%\.claude\plugins\cache\memory-anywhere\memory-anywhere\0.1.0/dist/memory-anywhere.mjs mcp --tool claude-code
Cursor.exe  pid 61596  16:24:39  "C:\Program Files\cursor\Cursor.exe" --type=utility --utility-sub-type=node.mojom.NodeService …
Cursor.exe  pid 43992  16:24:36  "C:\Program Files\cursor\Cursor.exe"
```

Cursor's plugin log (`Cursor Plugins.*.log`) loads both plugins, and its MCP log restarts the shared id at 16:29:50:

```
loadUserLocalPlugin memory-anywhere loaded in 613.0ms
loadClaudePlugin memory-anywhere@memory-anywhere loaded in 56.3ms
loadAllPlugins completed in 12303.7ms (claude=true, userLocal=true, marketplace=2 sources, total=4 plugins, failures=0, sourceUnavailable=false)
[McpProcessServerService] reload: plugin-memory-anywhere-memory-anywhere::… reason=config_changed
```

Cursor's hooks log for each window: `Loaded 2 user hook(s) for steps: sessionStart, beforeSubmitPrompt` (only `~/.cursor/hooks.json`).

Environment of the two hosts' proxies (names only; values shown for path variables):

| Variable | Cursor (pid 30808) | Claude Code (pid 57752) |
| --- | --- | --- |
| `CLAUDECODE` | absent | `1` |
| `CLAUDE_PROJECT_DIR` | absent | the project folder |
| `CLAUDE_PLUGIN_ROOT` | absent | the plugin folder |
| `WORKSPACE_FOLDER_PATHS` | the first window's folder (another repo) | absent |
| `VSCODE_CWD` | `C:\Program Files\cursor` | absent |

After the fix (spec-issues #51), the installed Claude Code bundle started as Cursor starts it (`--tool claude-code`, home
folder, the Cursor variables above, no `CLAUDE*`) logs `{"op":"proxy.repo","tool":"cursor",…}`; after a Cursor
`beforeSubmitPrompt` hook for the test repo, `memory_status` reports `"repo_enabled":true`.

## The same code outside Cursor

A probe (git-ignored `.gate/cursor-probe.mjs`) starts the installed bundle as `mema mcp --tool cursor` from the home folder (no
workspace, as Cursor does) and calls `memory_status` and `memory_recall`. It reads the `cursor-active.json` that Cursor's own hooks
wrote (`rk_39de9dc2db79f6882daea64098c5a71c`, the test repo) and acts for the enabled test repo.
