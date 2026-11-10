# 0019 ChatGPT on the phone

Status: accepted (the ChatGPT phone app works)
Date: 2026-11-10
Milestone: M0
Question: Q01 (phone)

## Context
The owner's binding decision includes ChatGPT on the phone. OpenAI documents Developer Mode for "the web" only
([Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)). The round-3 audit (SF6) found that v3 had made
the phone a non-goal, contradicting the owner. M0 Q01 tests two phone surfaces with the same account:
- the ChatGPT phone app;
- chatgpt.com in the phone's browser.

Every surface that works gets its own suite X row. If neither works, this ADR records a known limitation with re-test triggers.

## Options
1. A surface works: it gets a suite X row, and nothing else changes.
2. No surface works: a known limitation with re-test triggers. The design is unchanged, because ChatGPT uses the standard path.

## Method
- **Setup:** the ChatGPT custom MCP app was created on the PC web app (ADR-0101, ADR-0102) against the spike, release 0.0.1-m0.16.
- **Checks:** on the owner's phone, in fresh chats: "What is my test planet?" (a fact that exists only in memory-anywhere), then
  "Remember that my test color is amber."
- **Also checked:** the ChatGPT desktop app on Windows, with the same question.
- **Confirmation:** the server log and the stub's rows confirm each call.

## Result
Evidence: [`docs/results/evidence/ADR-0019/phone-and-desktop.md`](../results/evidence/ADR-0019/phone-and-desktop.md).
- **ChatGPT phone app: recall and save work.** The log shows `tools/call:memory_recall` and then `tools/call:memory_save`, with the
  row "The user's test color is amber." The connector made on the web was available in the app with no setup.
- **ChatGPT desktop app (Windows): recall works.**
- **chatgpt.com in the phone's browser:** not run. The owner decided it is the same chatgpt.com web app already tested on the PC (ADR-0101), so it needs no separate test.

## Decision
- **ChatGPT on the phone is supported through the ChatGPT app** (option 1). Suite X gets a "ChatGPT phone app" row, and also a
  "ChatGPT desktop app" row.
- **The phone browser** gets no separate suite X row. It is the web app covered by the PC web row (owner decision, 2026-11-10).
- **No design change.** The re-test triggers below are dropped, because the surface works.

## Consequences
- **Same grant everywhere.** The phone app uses the ChatGPT web grant, `client_policy` and approval behaviour.
- **One custom instruction.** The instruction set in ChatGPT's settings is account-wide, so it applies on the phone too.
- **Watch for regressions.** If OpenAI ever limits Developer Mode apps to the web, suite X's phone row fails first.
