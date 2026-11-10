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

## Q08 found: the tool-loading setting (claude.ai web, same account), 2026-11-09 ~01:40 UTC
Explored by Claude Code in the owner's Chrome (owner's request), claude.ai settings dialog:
- Settings → Connectors now says, verbatim: "Connectors have moved to Customize. Head there to browse, connect, and manage them."
- **Settings → Capabilities → Advanced → "Connectors in new chats"**: "Choose when Claude gets your connected apps ready."
  Options, verbatim: "Only when a chat needs them" ("Leaves more room in long sessions.", the default here) and
  "At the start of every chat" ("Always ready, but Claude has to summarize long sessions sooner.").
  Choosing the second showed the toast "Tool access set to load all tools up front". It is account-wide, not per connector.
- Per connector (Customize → connector): Tool permissions, Needs approval / Always allow / Blocked (see above).
- Custom instruction field (Q19): **Settings → Your Claude → Instructions** ("Claude will keep these in mind for this and any of
  your associated accounts across chats…", placeholder "e.g. keep explanations brief and to the point"). No limit shown in the UI.
- Same page: Claude's own memory ("Search and reference chats", "Generate memory from chats"), both on for this account.

## Automatic save and recall (claude.ai web, fresh chats, Opus 5.5)
| # | Tool loading | Custom instruction | Prompt | Reply (verbatim) | Activity shown | memory-anywhere |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | at start of every chat | none | "Remember that my test animal is otter." | "Got it — your test animal is otter. 🦦" | "Read and updated memory"; Memory: Added to · Test Values | not called (Claude's own memory took it) |
| 2 | at start of every chat | set (text below) | "Remember that my test fruit is mango." | "Got it — your test fruit is mango." | "Used memory-anywhere, read memory, updated memory" | saved |
| 3 | at start of every chat | set | "What is my test planet?" (fact only in memory-anywhere, inserted by the operator) | "Your test planet is Neptune." | "Used memory-anywhere, read memory" | recalled |
| 4 | only when a chat needs them | set | "Remember that my test city is Lisbon." | "Got it — Lisbon." | "Used memory-anywhere, read memory, updated memory" | saved |

Custom instruction used: "memory-anywhere is my personal memory across all my AI apps. When I state a lasting fact, preference or
decision about myself, save it with memory-anywhere's memory_save. Before answering anything that depends on who I am, check memory_recall."

Stub JSONL on the instance after the runs (verbatim):
```
{"id":"mem_46c802ca3f35f81f","text":"Test color is teal","user_words":"my test color is teal","client":"oauth","saved_at":"2026-11-09T01:33:43.512Z"}
{"id":"mem_fefd78b9e05bc103","text":"Test fruit is mango","user_words":"Remember that my test fruit is mango.","client":"oauth","saved_at":"2026-11-09T01:45:35.652Z"}
{"id":"mem_m0fixture00planet","text":"Test planet is Neptune","user_words":"(M0 fixture inserted by the operator for the recall test)","client":"m0-fixture","saved_at":"2026-11-09T01:46:32.924Z"}
{"id":"mem_e4ae475cf36953a9","text":"His test city is Lisbon","user_words":"Remember that my test city is Lisbon.","client":"oauth","saved_at":"2026-11-09T01:47:53.557Z"}
```
Observations:
- Without the custom instruction, Claude's own memory answers "remember…" even with the connector's tools loaded; with it, Claude
  calls memory-anywhere (and also its own memory). The instruction alone is enough; tool loading up front is not needed.
- Run 4 wrote "His test city…": the model guessed a pronoun. The `memory_save` text rules should require pronoun-free facts
  ("Test city is Lisbon"); for M1 (memory-policy.md §6).
- The account's tool loading was set back to "Only when a chat needs them" after the runs; the custom instruction stays.
