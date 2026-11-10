# Q10 Gemini custom MCP app, gemini.google.com on Windows (Chrome), Google AI Pro, 2026-11-09 (UTC)

Driven by Claude Code in the owner's Chrome at the owner's request. The owner approved the passkey prompts and asked Claude Code to
accept Google's risk acknowledgement for this test.

## Where and how
- **Location:** Settings → **Developer Mode** (`gemini.google.com/devmode`) → "Choose an app" → **Create new** → "Connect to an MCP server".
  Fields: MCP Server URL; **Additional settings** → Client ID, Client secret, **Copy redirect URI**.
- **Redirect URI (verbatim shape):** `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<owner's Google user id>-<server host, dots as underscores>`.
  It is per user and per server: `mema` cannot preset it; the owner copies it from the dialog into the pairing window.
- **Connect steps:**
  1. "Connect this MCP server" disclosure, with the box "I understand and accept the security and privacy risks of connecting this custom app".
  2. "Link your Google Account and [Custom] <host label> account" → **Agree and continue**.
  3. Our consent page.
  4. Back on `gemini.google.com/devmode?custom_mcp_action=auth_complete…`.
  5. **"Save your custom app"**, listing the actions memory_status, memory_save and memory_recall → **Connect**.
- **Failed first attempt:** navigating away before step 5 left the app unsaved ("No custom MCP servers yet"), although the grant
  existed on the server.
- **Result:** the Authentication tab shows "Connected · Account linked". Chats use the app in Developer Mode, by name or with `@Memory Anywhere`.

## Server side (access log, query strings never logged; user ids redacted)
```
16:17:59Z grant_created vendor=gemini redirect=https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<gid>-<host>   (first connect, app not saved)
16:26:… grant_created vendor=gemini (second connect)
HEAD /mcp 404 ua=Google
GET  /mcp 401 ua=Google
GET  /.well-known/oauth-protected-resource/mcp 200 ua=Google
GET  /.well-known/openid-configuration 200 ua=Google        <- Gemini discovers through the OIDC path, not oauth-authorization-server
POST /mcp 401 ua=Google
GET  /oauth/auth 303 (owner's Chrome) → consent → approve → /oauth/auth/<uid> 303
POST /oauth/token 200 ua=OpenAuth                           <- client_secret_basic, static client: works
POST /mcp 200 initialize; POST /mcp 202 notifications/initialized; GET /mcp 405; POST /mcp 200 tools/list
```

## Chats (Developer Mode, app "Memory Anywhere")
| # | Model | Prompt | Result (verbatim) | Server |
| --- | --- | --- | --- | --- |
| 1 | 3.8 Flash | "What is my test planet?" (normal chat, not Developer Mode) | "I'm having a hard time fulfilling your request. Can I help you with something else instead?" | no request |
| 2 | Flash | "What is my test planet?" | spinner for over 2 minutes, no answer | initialize, tools/list only |
| 3 | Flash | "Use Memory Anywhere to tell me my test planet." | "I encountered an error doing what you asked. Could you try again?" | tools/list only |
| 4 | Flash | same, after schema changes (below) | "I'm having a hard time fulfilling your request…" / spinner | tools/list only |
| 5 | Flash | "@Memory Anywhere what is my test planet?" | spinner, no answer | tools/list only |
| 6 | **3.1 Pro** | "Use Memory Anywhere to tell me my test planet." | approval card "Let Gemini use memory recall? … Don't allow · Allow once · Always allow"; Allow once → "Your test planet is Neptune." | tools/call memory_recall |
| 7 | Pro | "Remember that my test river is the Nile." | spinner, no answer | tools/list only |
| 8 | Pro | "Use the Memory Anywhere memory_save tool to save this: my test river is the Nile." | approval "Let Gemini use memory save?"; Allow once → "I've saved that your test river is the Nile." | tools/call memory_save; row "Test river is the Nile" |
| 9 | Pro, instruction set | "Remember that my test tree is oak." | "Got it. I will remember that your test tree is oak." | no tools/call (not saved) |

Schema changes tried while Flash failed (none changed Flash; kept, because Gemini accepts only a subset of JSON Schema):
- `memory_status` input `{"type":"object"}` instead of `{"type":"object","properties":{}}` (release 0.0.1-m0.9).
- All tool schemas without `$schema` (0.0.1-m0.10).
- `memory_status` without the canary padding (systemd drop-in `MA_STUB_SHORT_STATUS=1` on 0.0.1-m0.11; removed afterwards).

## Q19 instruction field
- **Location:** Settings → Personal Intelligence → **Instructions for Gemini** (`gemini.google.com/saved-info`) → Add →
  "What do you want Gemini to remember?". The field has a maxlength of 3000.
- **Rejected:** the Claude/ChatGPT text ("memory-anywhere is my personal memory … save it with memory-anywhere's memory_save … check
  memory_recall.") got "**Gemini can't save this info.**"
- **Accepted:** "Use my Memory Anywhere app to save lasting facts and preferences I tell you about myself, and check it before answering
  anything that depends on who I am." (toast "Info saved"). It did not make Gemini call memory_save unprompted (run 9).

## Refresh with rotation on (Q10)
The access token from the 16:26 connection expired at about 17:26. The next Gemini tool use refreshed:
```
18:27:52Z POST /oauth/token 200 ua=OpenAuth        <- refresh_token grant, rotation on (client_policy rotate)
18:27:53Z POST /mcp 200 initialize … 18:28:35Z POST /mcp 200 tools/call:memory_recall
```
Gemini accepts a rotated refresh token.

## Second refresh: the rotated refresh token is kept (Q10), 2026-11-10
The access token from the 18:27 refresh expired at about 19:28. In a fresh Developer Mode chat (3.1 Pro) the next morning,
"Use Memory Anywhere to tell me my test planet." → approval → Allow once → "Your test planet is Neptune."
```
00:20:02Z POST /oauth/token 200 ua=OpenAuth        <- refresh_token grant with the token issued by the 18:27 rotation
00:20:03Z POST /mcp 200 initialize (client ma_gCHe…) … 00:20:20Z POST /mcp 200 tools/call:memory_recall
```
No `grant.error` was logged. Gemini stores and uses each rotated refresh token, so rotation stays on. The rotation-off run in
Q10's method was not needed, because the spec runs it only to choose `fixed` when rotation fails.
