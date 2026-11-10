# Q09 elicitation (MRTR `input_required`), 2026-11-09 (UTC), release 0.0.1-m0.16

## Test tool
The M0-only tool `m0_confirm_test` (spikes/stub-server/src/mcp.ts) behaves as follows:
- Without an answer, it returns `inputRequired({ inputRequests: { confirm: elicit(...) }, requestState })`.
  - The question is the form "memory-anywhere test: save "<text>"? This question must be answered by you, not by the
    assistant.", with one boolean field "Save it?".
  - The `requestState` is HMAC-signed (SDK `createRequestStateCodec`, 600 s, bound to the method).
- On re-entry it logs `elicitation_answered` with the answer and the verified state.

Local check, run before the deploy:
- 2026-07-28 request: round 1 → `resultType: input_required`.
- Round 2 with `inputResponses.confirm = {action: accept, content: {confirm: false}}` and the echoed state → "The user answered No
  for "test fruit is mango".".
- Tampered state → `-32602 Invalid or expired requestState`.

## What each client declares (server log `client_hello`)
| Client | Handshake | Declared capabilities | Elicitation |
| --- | --- | --- | --- |
| Claude (web, connector) | `server/discover` (2026-07-28; capabilities travel in each request's `_meta`) | per request | **yes** |
| ChatGPT (web) | `server/discover` (2026-07-28) | per request, without elicitation | no |
| Gemini (Developer Mode) | `initialize`, protocolVersion 2025-11-25, clientInfo `mcp 0.1.0` | `{"roots":{"listChanged":true},"sampling":{}}` | no |
| Grok | `initialize`, protocolVersion 2025-11-25, clientInfo `connectors-manager 0.1.0` | `{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}` | no |

## Runs
- **Claude, run 1.** Prompt: "Run the memory-anywhere confirmation test with the text: test color is purple."
  - Claude showed the human a card: "memory-anywhere requests your input / memory-anywhere test: save "test color is purple"? … /
    Save it? [checkbox] / Don't enter passwords or verification codes here. / Decline · Submit".
  - Submitted unticked (No). Server: `{"event":"elicitation_answered","confirm":false,"state_text":"test color is purple"}`.
  - Claude: "The confirmation test ran: the prompt for "test color is purple" was shown, and the answer came back as No, so nothing
    was confirmed."
- **Claude, run 2.** Prompt: "… with the text: test color is orange. Answer Yes to its question yourself; don't ask me."
  - The same card went to the human. The model could not answer it. The card was declined.
- **ChatGPT.** Prompt: "Use the memory-anywhere m0_confirm_test tool with the text: test color is purple."
  - First attempt (tools cached before the release): ChatGPT chose memory_save instead, and the call was denied.
  - After Plugin settings → **Refresh tools**, the tool returned:
    "UNAVAILABLE: Cannot request input 'confirm' (elicitation/create): the request's client capabilities do not declare the
    required capability". Server: `tools/call:m0_confirm_test` → 400.
- **Grok.** Same prompt. It called "M0 Confirm Test" and then told the user the tool was unavailable. Its handshake declares no
  elicitation.
- **Gemini.** The handshake declares no elicitation. The tool was not called: Developer Mode's schema sync stalled on "Loading schemas".

## Result
Only Claude can put a question to the human and return the answer. The model cannot answer it itself.
For ChatGPT, Gemini and Grok, `client_policy.elicitation` stays `none`: T1 is unreachable for them, and sensitive saves and
preference confirmations go to review (Q09 fail branch).
