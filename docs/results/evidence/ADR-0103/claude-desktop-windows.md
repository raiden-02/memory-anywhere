# Claude Desktop (Windows), custom connector on the spike, 2026-11-09 (UTC)

Server: spike release 0.0.1-m0.5 (OAuth spike over the stub), `https://spike.{host}/mcp`.
Owner: Claude Desktop app on Windows 11, Chat, same Claude account as claude.ai.

## Q04 static client credentials
- Admin page: pairing window for Claude, method static. Connector added with name, URL
  `https://spike.{host}/mcp`, and the window's OAuth Client ID and Client Secret under Advanced settings.
- Consent page on the spike, approved with the owner passkey.
- Server log (journalctl -u memory-anywhere), verbatim except the client id:
  `{"event":"grant_created","vendor":"claude","client_id":"ma_…","redirect_uri":"https://claude.ai/api/mcp/auth_callback"}`
- The connector then also appeared in a running Claude Code session on the same account; `memory_status` from it:
  `{"store":"m0-stub","healthy":true,"policy_version":"P1","version":"0.0.1-m0.5","memories":0}`

## Save
1. New chat: "Remember that my test color is teal." Reply, verbatim: "Got it — teal."
   No tool call; the stub's JSONL stayed empty.
2. New chat: "Use the memory-anywhere memory_save tool to save this: my test color is teal." Reply, verbatim:
   ```
   Loaded
   memory-anywhere
   Reviewing the tool's server instructions.

   Saved: your test color is teal.
   ```
   Stub JSONL on the instance afterwards:
   `{"id":"mem_46c802ca3f35f81f","text":"Test color is teal","user_words":"my test color is teal","client":"oauth","saved_at":"2026-11-09T01:33:43.512Z"}`
   Observation: the connector's tools are loaded on demand ("Loaded memory-anywhere"), only when the prompt names them.

## Q08 per-connector settings found so far
- Connector → Tool permissions: **Needs approval**, **Always allow**, **Blocked** (owner chose Always allow).
  This controls approval, not whether tools are loaded up front ("Tool access"): still being looked for.
