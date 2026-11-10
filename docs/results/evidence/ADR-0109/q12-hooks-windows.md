# Q12 Hook payloads and behaviour on Windows, 2026-11-09 (UTC)

Windows 11 Home 10.0.26200, Node 24.22.2. Every hook runs `spikes/hook-recorder/record.mjs <tool> <event>`. It records the stdin
JSON, argv, cwd and the environment variable *names*, and on session start prints a canary context in the tool's documented shape.
Each check below asks a fresh session: "If you were given a memory-anywhere hook canary, reply with it exactly; otherwise reply
NONE." The expected reply is `HOOK-CANARY-5RJ8`. The fixtures are in `evals/fixtures/hooks/<tool>/<version>/`, anonymised.

## Claude Code 2.1.319
- 3/3 headless sessions (`claude -p`, plugin loaded with `--plugin-dir` from a path with spaces) answered the canary.
- `SessionStart` (source `startup`) and `UserPromptSubmit` fired once per session.
- Payload keys and the headless flags are recorded in
  [../ADR-0105/claude-code-q07-q12-q13-q17.json](../ADR-0105/claude-code-q07-q12-q13-q17.json):
  - `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` removes every MCP server.
  - `--setting-sources ""` keeps plugin and claude.ai servers but drops user servers.

## Codex CLI 0.167.0
- **Setup:** user-level `~/.codex/hooks.json` with `SessionStart` (matcher `startup|resume`) and `UserPromptSubmit`, each with
  `command` and `commandWindows` set to `node "<abs path with a space>\record.mjs" codex <event>`.
- **Before trust:** `codex exec` skipped both hooks without any message, and the model answered NONE.
- **Trust:** the owner trusted the hooks once in `/hooks`. Codex stores the trust in `config.toml` as
  `[hooks.state.'<file>:<event>:0:0'] trusted_hash = "sha256:…"`, so any edit to the hook needs a new trust.
- **After trust:** 3/3 `codex exec` sessions replied `HOOK-CANARY-5RJ8`. The session-start stdout shape
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}` reaches the model.
- **Payload keys:**
  - SessionStart: `session_id, transcript_path, cwd, hook_event_name, model, permission_mode, source`.
  - UserPromptSubmit: the same plus `prompt`.
- A quoted `node "<path with a space>"` command works in `commandWindows`.

## Cursor 3.29.9
Hooks are user-level `~/.cursor/hooks.json` with `"version": 1`, events `sessionStart` and `beforeSubmitPrompt`. Cursor reloads the
file on save, runs each hook from `~/.cursor` as the working directory, and writes every run (command, input, output, exit code)
to its "Hooks" output channel (`%APPDATA%\Cursor\logs\…\cursor.hooks.*.log`). The model was `grok-4.7` (Cursor's default).

| Session | Hook script location | Path has a space | Result |
| --- | --- | --- | --- |
| 1–3 | `%LOCALAPPDATA%\memory-anywhere\spike\hook recorder\record.mjs` | yes | exit 1 `Error: Cannot find module '<that path>'` on every run; reply NONE |
| 4 | `~\.cursor\hooks\ma-m0-record.mjs` | no | both hooks exit 0; reply `HOOK-CANARY-5RJ8` |
| 5 | sessionStart: `~\.cursor\hooks\ma m0\record.mjs` | yes | exit 0; reply `HOOK-CANARY-5RJ8` |
| 5 | beforeSubmitPrompt: `%LOCALAPPDATA%\memory-anywhere\spike\hookrec\record.mjs` | no | exit 1 `Cannot find module` |

- **`node "<abs>" …` passes through unchanged.** Cursor does not apply the `.ps1` rule to it, and a quoted path with a space works.
- **Cursor's hook process cannot load a script from `%LOCALAPPDATA%`.** Node reports `MODULE_NOT_FOUND` for a file that exists.
  The same command works from PowerShell. The failure is about the location, not the space. The same hook process can *write*
  under `%LOCALAPPDATA%`: the recorder wrote its output there in sessions 4 and 5.
- **Order is not fixed.** In sessions 1–3 `beforeSubmitPrompt` started about 2 s before `sessionStart`; in 4–5 `sessionStart` came
  first. clients.md already treats `sessionStart` as fire-and-forget.
- Each hook took about 3.5 s, against 0.4 s for the failing runs. That is Node start-up plus the recorder's 3 s stdin guard.
- **Payload keys** (both events): `conversation_id, generation_id, model, model_id, model_params, composer_mode, session_id,
  hook_event_name, cursor_version, workspace_roots, user_email, transcript_path` (null).
  - `sessionStart` adds `is_background_agent`.
  - `beforeSubmitPrompt` adds `prompt, attachments`.
  - `workspace_roots` entries are URL-style (`/C:/Users/…`).
- **Outputs accepted:** `{"additional_context": "…"}` for `sessionStart`, `{"continue": true}` for `beforeSubmitPrompt`.
- **Environment variable names** given to the hook: `CURSOR_PROJECT_DIR, CURSOR_VERSION, CURSOR_USER_EMAIL,
  CURSOR_WORKSPACE_LABEL, CLAUDE_PROJECT_DIR`, among others.

## Field mapping against clients.md §3
- **Claude Code and Codex:** `session_id`, `cwd` and `prompt` exist as clients.md expects.
- **Cursor:** `prompt` and `workspace_roots` exist as expected. Cursor has no `cwd`, so the client uses `workspace_roots[0]`
  (converted from the URL form) and falls back to `CURSOR_PROJECT_DIR`.
