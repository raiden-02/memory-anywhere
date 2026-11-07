# 0019 ChatGPT on the phone

Status: proposed (decided by M0 Q01)
Date: 2026-11-07

## Context
The owner's binding decision includes ChatGPT on the phone. OpenAI documents Developer Mode for "the web" only ([Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)). The round-3 audit (SF6) found v3 had made it a non-goal, contradicting the owner.

## Decision
ChatGPT on the phone is a goal. M0 Q01 tests the ChatGPT phone app and chatgpt.com in the phone's browser with the same account. Every surface that works gets its own suite X row. If neither works, this ADR is accepted as a **known limitation** for v1, and the design does not change: ChatGPT uses the standard path, so phone support needs no work from us when OpenAI enables it.

## Re-test triggers (if the limitation is recorded)
- OpenAI's Developer Mode or Apps documentation mentions mobile or desktop apps.
- A ChatGPT app release note mentions custom connectors or MCP on mobile.
- Otherwise, every 3 months; the daily digest reminds the owner. A re-test is the Q01 phone steps only.

## Consequences
Until a re-test passes, the owner uses Claude or Gemini on the phone for memory, and ChatGPT on the PC web app.
