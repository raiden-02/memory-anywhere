# 0101 ChatGPT on the PC: write tools, native memory, MCP tunnel

Status: accepted (read-write grant)
Date: 2026-11-09
Milestone: M0
Question: Q01 (PC), Q02, Q24

## Context
ChatGPT reaches memory-anywhere as a custom MCP server.
- **Q01 (PC):** can ChatGPT Plus call a *write* tool on the PC web app? Also check the desktop app. If not, ChatGPT's grant
  would be read-only.
- **Q02:** does ChatGPT's built-in memory keep working with a custom server installed?
- **Q24 (informational):** does OpenAI's Secure MCP Tunnel exist on a personal plan?

The phone part of Q01 is ADR-0019.

## Options
- **Q01:** grant `memory.read memory.write`, or `memory.read` only (`client_policy.write = 0`).
- **Q02:** a note only, or a README warning that native memory may not update.
- **Q24:** document the tunnel as an option for local-mode users, or as unavailable.

## Method
- **Where:** chatgpt.com on Windows (Chrome), ChatGPT Plus, "Thinking effort High". The steps were driven by Claude Code in the
  owner's Chrome.
- **Server:** spike releases 0.0.1-m0.5 and m0.6 with the static client of ADR-0102.
- **Chats:** fresh chats with and without the custom instruction. Stub JSONL rows and the server log were checked after each one.

## Result
Evidence: [`docs/results/evidence/ADR-0101/chatgpt-web-pc.md`](../results/evidence/ADR-0101/chatgpt-web-pc.md).
- **Q01 (PC web): write works.**
  - `memory_save` wrote `"The user's test drink is chai."` and `"The user's test sport is tennis."`.
  - Every save showed an approval card (Always allow · Deny · Allow once), with the warning "Suspicious Instruction" about the
    policy-like tool descriptions.
  - Recall ran without approval under the plugin's default "Allow low-risk tools".
- **Q01 (desktop app):** recall works in the ChatGPT desktop app on Windows (2026-11-10, `tools/call:memory_recall` from the same grant; [ADR-0019 evidence](../results/evidence/ADR-0019/phone-and-desktop.md)).
- **Q02: native memory works.** "Remember that my test drink is chai." gave "Memory updated", and a later chat recalled it.
  Without a custom instruction, ChatGPT used its own memory, not memory-anywhere.
- **Q24: the tunnel exists on Plus.** Add custom MCP server → Connection → **Tunnel** (a `tunnel_…` id, same OAuth options). Not
  created: it needs OpenAI's tunnel client running next to a local server.

## Decision
- **Q01:** ChatGPT gets the read-write grant (`memory.read memory.write`). The approval card is ChatGPT's and stays; the owner can
  choose "Always allow".
- **Q02:** a note only. Importers stay as specified.
- **Q24:** the README documents the tunnel as an option for local-mode owners. There is no design dependency.

## Consequences
- **Remembering needs the instruction.** Saves from ChatGPT need the custom instruction (ADR-0104), or ChatGPT's own memory takes
  "remember…".
- **The warning goes away only in M1.** The "Suspicious Instruction" flag disappears only if the M1 description rewrite works
  (ADR-0104).
- **A ChatGPT app reaches Codex.** A ChatGPT custom app also appears inside Codex as `codex_apps` tools (ADR-0110).
