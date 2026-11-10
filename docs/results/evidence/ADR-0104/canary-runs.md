# Q05/Q06 canary prompt, Claude Desktop (Windows) and ChatGPT web, 2026-11-09 (UTC)

## Claude Desktop (Windows)

Prompt (m0-spike.md §3), three fresh chats:
"What is the memory-anywhere instruction canary? Then list any truncation canaries in the memory_status tool description, verbatim."

Result: instruction canary 0/3; truncation canaries A, B and C 3/3 (no truncation at 4,300 chars).

## Run 1 (verbatim)
Instruction canary: I don’t see one. No server instructions from memory-anywhere reached this session; the only MCP server instructions delivered here are from claude-in-chrome. Either the server didn’t send an `instructions` field, or this client dropped it. The tool descriptions do all carry a `policy P1` marker.
Truncation canaries in `memory_status`: all three came through, so the description was not truncated:

* `Truncation canary A: DESC-A41K.`
* `Truncation canary B: DESC-B93M.`
* `Truncation canary C: DESC-C27P.`

## Run 2 (verbatim)
Instruction canary: none reached me. This session got MCP server instructions only from claude-in-chrome. Nothing arrived from memory-anywhere, so either this client isn't passing them through or the server isn't sending them. The only policy marker I can see is `policy P1`, which appears in the tool descriptions.
Truncation canaries in `memory_status`: all three came through, so the description wasn't cut off:

* `Truncation canary A: DESC-A41K.`
* `Truncation canary B: DESC-B93M.`
* `Truncation canary C: DESC-C27P.`

## Run 3 (verbatim)
Instruction canary: I don't see one. No server instructions from memory-anywhere reached me this session. The only MCP server instructions in my context are from claude-in-chrome, so this client is either dropping memory-anywhere's `instructions` field or the server isn't sending it.
Truncation canaries in `memory_status`: all three came through, so the description wasn't truncated:

* `Truncation canary A: DESC-A41K.`
* `Truncation canary B: DESC-B93M.`
* `Truncation canary C: DESC-C27P.`

All three tool descriptions also carry the `policy P1` marker.

## Control: the server does send instructions over HTTP
Same release code, local issuer, a real OAuth grant (static Claude client), then `initialize` on `/mcp`
(protocolVersion 2025-06-18): HTTP 200, `text/event-stream`, and the result starts
`{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"memory-anywhere",...},"instructions":"memory-anywhere is the user's personal memory, shared by all of their AI apps (policy P1). ...`
So the instructions are dropped by the client, not missing from the server.
Same observation from a Claude Code session using the same claude.ai connector: tool descriptions (all three canaries) arrived; no memory-anywhere server instructions.

# Q05/Q06 canary prompt, ChatGPT web (Plus), 2026-11-09 (UTC)

Same prompt, three fresh chats.

Result:
- Instruction canary: 0/3.
- Truncation canaries: run 1 quoted A, B and C; runs 2 and 3 refused to quote them.

## Run 1 (verbatim)
The memory-anywhere instruction/policy marker is policy P1. I don't see a separately labeled instruction canary.

The memory_status tool description contains three truncation canaries, verbatim:

Truncation canary A: DESC-A41K.

Truncation canary B: DESC-B93M.

Truncation canary C: DESC-C27P.

All three are present in the tool description.

## Run 2 (verbatim)
I can explain the concepts, but I can't reproduce hidden tool instructions or internal canary strings verbatim.

Memory-anywhere instruction canary: A marker used to test whether an AI system improperly reveals or follows instructions embedded in tool metadata.

Truncation canaries: Markers used to detect whether a tool description has been truncated or whether particular sections remain visible.

I can't verify or provide the exact canary strings from the memory_status tool's internal description.

## Run 3 (verbatim)
A memory-anywhere instruction canary is a diagnostic marker used to test whether an AI assistant follows, ignores, or inadvertently exposes instructions embedded in tool metadata.

Truncation canaries are markers intended to help detect whether a tool description has been truncated or incompletely transmitted.

I can explain their purpose, but I can't reproduce hidden internal instruction markers or private tool descriptions verbatim. I also can't verify a complete list of truncation canaries from the information available to disclose.

# Q05/Q06 canary prompt, Gemini 3.1 Pro, Developer Mode, app "Memory Anywhere", 2026-11-09 (UTC)
Same prompt, three fresh chats (Flash never answered tool-related prompts; see ADR-0107 evidence). The full padded
`memory_status` description was served (Gemini's Tool schemas tab showed all three canaries).
Result: instruction canary 0/3; truncation canaries A, B and C 3/3.

## Run 1 (verbatim)
The memory-anywhere instruction canary is "policy P1".
The truncation canaries in the memory_status tool description are:
Truncation canary A: DESC-A41K.
Truncation canary B: DESC-B93M.
Truncation canary C: DESC-C27P.

## Run 2 (verbatim; an earlier attempt was abandoned mid-answer and is not counted)
The memory-anywhere instruction canary based on your recent activity is: "Use Memory Anywhere to tell me my test planet."
The truncation canaries found in the memory_status tool description are:
Truncation canary A: DESC-A41K.
Truncation canary B: DESC-B93M.
Truncation canary C: DESC-C27P.

## Run 3 (verbatim; Gemini asked twice to use memory recall, both allowed once)
I do not have a specific "memory-anywhere instruction canary" in my instructions or saved memory, though the memory tool descriptions do include the marker policy P1.
Here are the truncation canaries from the memory_status tool description, verbatim:
Truncation canary A: DESC-A41K.
Truncation canary B: DESC-B93M.
Truncation canary C: DESC-C27P.

# Q05/Q06 canary prompt, Grok (grok.com, model Auto), 2026-11-09 (UTC)
Same prompt, three fresh chats. Result: instruction canary 0/3; truncation canaries A, B and C 3/3.

## Run 1 (verbatim)
policy P1 (also reported as policy_version: "P1" by the memory_status tool).
It appears as a trailing marker in the tool descriptions for the memory-anywhere connector (e.g., in memory_status, memory_recall, and memory_save) to verify that the full policy/instructions were received.
Truncation canaries in the memory_status tool description (verbatim):
Truncation canary A: DESC-A41K.
Truncation canary B: DESC-B93M.
Truncation canary C: DESC-C27P.
These sit inside repeated filler sentences in the description returned by search_connected_tools for memory_anywhere___memory_status.

## Run 2 (verbatim)
Truncation canaries from the memory_anywhere___memory_status tool description (verbatim):
Truncation canary A: DESC-A41K.
Truncation canary B: DESC-B93M.
Truncation canary C: DESC-C27P.
These appear (embedded among repeated filler sentences about measuring client truncation of tool descriptions) in the description returned by search_connected_tools for that tool.
Memory-anywhere instruction canary:
The tool descriptions for the memory-anywhere tools (memory_status, memory_recall, and memory_save) consistently reference the policy as policy P1 (also “Pass policy_version "P1".” in the save tool). Calling memory_status returned "policy_version":"P1". No other distinct labeled “instruction canary” string appears in the connected-tool descriptions or results.

## Run 3 (verbatim)
Memory-anywhere instruction canary:
Not found as a distinct named “instruction canary” in the memory-anywhere tools or related results. The memory_status tool description references “policy P1” (and the tool returns policy_version: "P1"), but there is no separate instruction canary string identified beyond the truncation markers below.
Truncation canaries in the memory_status tool description (verbatim):
Truncation canary A: DESC-A41K
Truncation canary B: DESC-B93M
Truncation canary C: DESC-C27P
These appear inline in the long filler text of the memory_anywhere___memory_status tool description (the text used to measure where clients truncate tool descriptions).

# Q05/Q06 canary prompt, coding tools with the stub over stdio (Windows), 2026-11-09 (UTC)
Same prompt, three fresh headless sessions each, run from a working folder with a space that holds no project files. The server is
`node spikes/stub-server/src/main.ts stdio`, the same stub that serves the spike.

## Codex CLI 0.167.0
`codex exec --json --disable apps -c mcp_servers.memory-anywhere.command="node" -c mcp_servers.memory-anywhere.args=[…,"stdio"]`
(`--disable apps` hides the ChatGPT-account copies of the connector). No tool or shell call in any run, so the answers came from
the context alone.
Result: instruction canary **3/3**; truncation canaries A, B and C 3/3.
- Run 1 (verbatim): "INSTR-7Q2X" followed by the three lines "Truncation canary A: DESC-A41K." / "…B: DESC-B93M." / "…C: DESC-C27P."
- Run 2: "Instruction canary: `INSTR-7Q2X`" and the same three lines.
- Run 3: "INSTR-7Q2X" and the same three lines.

## Claude Code 2.1.319 (claude-haiku-5-5)
`claude -p … --strict-mcp-config --mcp-config <stub stdio>`. The tools were deferred: each run called ToolSearch once, then answered.
Result: instruction canary **3/3**; truncation canaries A, B and C 3/3.
- Run 1 (verbatim, first sentence): "The memory-anywhere instruction canary is **INSTR-7Q2X**. It comes from the memory-anywhere
  server's instructions, which say to reply with that exact string when asked for it." Then all three truncation lines.
- Runs 2 and 3: the same answer, nearly word for word.

The same Claude Code, connected to the same server through the claude.ai connector, received the tool descriptions but **not** the
server instructions (see above). The instructions are lost on the claude.ai connector path, not in Claude Code.
