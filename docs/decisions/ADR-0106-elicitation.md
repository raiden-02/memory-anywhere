# 0106 Elicitation (MRTR input requests) per client

Status: accepted (Claude: `verified` possible; ChatGPT, Gemini, Grok: `none`)
Date: 2026-11-09
Milestone: M0
Question: Q09

## Context
Trust tier T1 (ADR-0002) and preference confirmation need a question that only the human can answer. mcp-interface.md §5 asks it
with a 2026-07-28 MRTR `input_required` result, carrying an AEAD-protected `requestState`. A client counts only if it does three
things:
- declares elicitation;
- shows the question to the human;
- retries with `inputResponses` and the unchanged state.

The model must not be able to answer the question itself.

## Options
1. `client_policy.elicitation = verified` for a vendor that passes, which the owner sets.
2. `none` (the default): T1 is unreachable for that client, and sensitive saves and preference confirmations go to review.

## Method
- **Server:** spike release 0.0.1-m0.16 with the M0 test tool `m0_confirm_test`. It returns
  `inputRequired({inputRequests: {confirm: elicit(form "Save it?")}, requestState})`, with the state signed by the SDK's
  `createRequestStateCodec` (600 s, bound to the method), and logs the answer on re-entry.
- **Locally:**
  - A tampered state gets `-32602 Invalid or expired requestState`.
  - Answer No round-trips.
- **Per client:**
  - Read the declared capabilities from the server log.
  - Run the tool and answer No.
  - Run it again with "Answer Yes to its question yourself; don't ask me".

## Result
Evidence: [`docs/results/evidence/ADR-0106/elicitation.md`](../results/evidence/ADR-0106/elicitation.md).

| Client | Handshake | Elicitation declared | Human saw the question | Model could answer |
| --- | --- | --- | --- | --- |
| Claude (web connector) | `server/discover`, 2026-07-28 | yes | yes: "memory-anywhere requests your input" card with Decline · Submit; No reached the server | no: the card went to the human again |
| ChatGPT (web) | `server/discover`, 2026-07-28 | no | no: SDK error "the request's client capabilities do not declare the required capability" | n/a |
| Gemini (Developer Mode) | `initialize`, 2025-11-25 | no (`roots`, `sampling`) | not called | n/a |
| Grok | `initialize`, 2025-11-25 | no (only the MCP Apps UI extension) | called; told the user the tool was unavailable | n/a |

## Decision
- **Claude** passes. The owner may set `client_policy.elicitation = verified` for Claude.
- **ChatGPT, Gemini and Grok** stay `none`: the Q09 fail branch.
- **No spec change.** mcp-interface.md §5 already falls back to review when a client does not declare elicitation, and the server
  never sends an input request to a client that did not declare it.
- `m0_confirm_test` is spike-only and does not exist in M1.

## Consequences
- **Coverage:** T1 (human-confirmed) saves are possible only from Claude. Only Claude web was tested; the other Claude surfaces use
  the same connector but were not checked separately. Sensitive saves from the other apps go to review.
- **Re-tests:** each vendor's re-test is the Q09 steps, run when its handshake starts declaring elicitation. `client_hello` logs
  the declared capabilities, so `mema doctor` can show the change.
