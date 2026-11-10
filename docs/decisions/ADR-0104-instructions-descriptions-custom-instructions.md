# 0104 Server instructions, tool-description truncation, custom instructions

Status: accepted
Date: 2026-11-09
Milestone: M0
Question: Q05, Q06, Q19

## Context
memory-policy.md delivers the memory policy three ways: MCP server instructions, tool descriptions (budgets in §5), and a custom
instruction the owner pastes into each app. The three questions:
- **Q05:** which clients pass server instructions to the model?
- **Q06:** where are tool descriptions truncated?
- **Q19:** where is each chat app's custom-instruction field, and what is its limit?

## Options
- **Q05:** per client, either rely on server instructions, or rely on tool descriptions plus the custom instruction (flagged in
  clients.md).
- **Q06:** keep the description budgets, or shrink them for all clients if any client cuts below 2,000 characters.
- **Q19:** print per-app steps, or rely on server instructions and tool descriptions where an app has no field.

## Method
- **Canary prompt (m0-spike.md §3), three fresh chats per client:** "What is the memory-anywhere instruction canary? Then list any
  truncation canaries in the memory_status tool description, verbatim."
- **Server:** the stub's instructions carry `INSTR-7Q2X`. `memory_status`'s description carries `DESC-A41K`, `DESC-B93M` and
  `DESC-C27P` at characters 1,900, 3,900 and 4,300.
- **Remote clients** used the spike (OAuth connector). Codex and Claude Code also ran the same stub over stdio.
- **Q19:** the owner's settings were explored in the owner's Chrome.

## Result
Evidence: [`docs/results/evidence/ADR-0104/canary-runs.md`](../results/evidence/ADR-0104/canary-runs.md). Q19 locations are in
the ADR-0101, 0103, 0107 and 0108 evidence.

| Client | Path | Instruction canary (Q05) | Truncation canaries A/B/C (Q06) |
| --- | --- | --- | --- |
| Claude Desktop (Windows) | claude.ai connector | 0/3 | 3/3 each |
| Claude Code (via claude.ai connector) | claude.ai connector | not received (control run) | received |
| Claude Code 2.1.319 | stdio | **3/3** | 3/3 each |
| ChatGPT web (Plus) | custom MCP app | 0/3 | run 1 quoted all three; runs 2–3 refused to quote internal text |
| Gemini 3.1 Pro (Developer Mode) | custom app | 0/3 | 3/3 each |
| Grok (Auto) | custom connector | 0/3 | 3/3 each |
| Codex CLI 0.167.0 | stdio | **3/3** | 3/3 each |
| Cursor 3.29.9 | stdio | pending the owner's run | pending |

**Control.** The spike's `initialize` result contains the `instructions` field (verified over HTTP with a real grant). So the
remote clients drop the instructions; the server does send them.

| App | Custom-instruction field (Q19) | Limit | Effect with the memory-anywhere text |
| --- | --- | --- | --- |
| Claude | Settings → Your Claude → Instructions | none shown | unprompted save and recall |
| ChatGPT | Settings → Personalization → Custom instructions → "ChatGPT instructions" | none shown | unprompted recall; saves attempted, each needing "Allow once", flagged "Suspicious Instruction" |
| Gemini | Settings → Personal Intelligence → Instructions for Gemini (`gemini.google.com/saved-info`) | 3,000 (`maxlength`) | text naming tools rejected ("Gemini can't save this info"); plain text accepted, but no unprompted save |
| Grok | Settings → Customize → Custom → "How should Grok behave?" | none shown | not needed: Grok saves and recalls unprompted without it |

## Decision
- **Q05: server instructions reach the model only over stdio** (Claude Code, Codex; Cursor pending). For every remote client
  (Claude apps, ChatGPT, Gemini, Grok), the policy relies on the tool descriptions plus the custom instruction. clients.md flags
  this per client.
  - The server still sends instructions, because they are free and the stdio clients use them.
  - `INSTR-7Q2X` is spike-only.
- **Q06: no client truncated at 4,300 characters.** The memory-policy.md §5 description budgets stand.
- **Q19:** `mema init --print-custom-instruction` prints, per app, the path above and a text that fits its rules:
  - Gemini gets the plain wording that Gemini accepted.
  - The others get the memory-policy.md §6 text.

## Consequences
- **The tool descriptions carry the policy** for remote clients, so their wording matters more.
- **ChatGPT flags policy-like descriptions.** It flagged our descriptions as "Suspicious Instruction" because they prescribe saving
  rules and classifier outcomes. M1 rewrites the descriptions in a neutral, descriptive voice (what the tool does and what each
  field means), without imperative policy language, and re-runs the ChatGPT approval check. Recorded in negative-results.md.
- **Gemini** saves only when asked explicitly, even with its instruction.
