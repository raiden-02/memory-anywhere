# 0007 LLM provider and pinned models

Status: accepted (extractor id pinned in M0 Q16)
Date: 2026-11-07

## Context
v2 used an LLM for slot proposal, extraction, judging and section naming without host, key, timeout or fallback (review2-architecture N9).

## Decision
All calls run on the server through one adapter (write-path.md §6.2). Owner deployment: provider `anthropic`, a small fast model pinned by dated id; judge off until suite P shows it helps; $1/day live cap, $20 import cap. Labelling families B and C (evals) come from OpenAI and Google, never Anthropic and never the extractor family. No-LLM mode is fully defined and tested.

## Consequences
Model ids are part of every cache key. Changing a model is a policy-version change and re-runs suite P.

## Update 2026-11-08: M0 Q16, pinned ids and extractor check

Question: Q16. Pinned dated id for the extractor/judge (provider `anthropic`, a small fast model); labelling families B and C only with eval keys.

### Method
- Ids, prices and availability from Anthropic's models overview (fetched 2026-11-08): Claude Haiku 5.5, API id `claude-haiku-5-5`, $0.10 input / $0.50 output per MTok for prompts up to 100K tokens ($0.50 / $2.50 above), 1M context, 128K output; on the Claude API, Amazon Bedrock (`anthropic.claude-haiku-5-5`), Claude Models on Google Cloud, Microsoft Foundry and Claude Platform on AWS; retirement not sooner than 2027-10-07. The overview states that "every Claude model ID is a pinned snapshot, including the dateless IDs used from the 4.6 generation on", so the dateless id is the pinned snapshot the spec asks for, not a floating alias.
- Extractor quality: `spikes/llm-extractor/q16.ts` sends the memory-policy.md §6.12 prompt byte for byte, 10 prompts per call, to `claude-haiku-5-5` through Claude Code headless 2.1.319 on the owner's subscription (no API key; evals.md §8.3), 3 runs over 50 synthetic prompts for the synthetic persona (26 with durable facts, one of them a sensitive fact with an explicit request to remember; 24 traps: task details, questions, documents, code, secrets, sensitive topics without a request, other people's private details, passing states). Labels are the implementing agent's (author-labelled; not a gate). Evidence: [`q16-extractor-claude-haiku-5-5.json`](../results/evidence/ADR-0007/q16-extractor-claude-haiku-5-5.json).

### Result
| Run | Facts recalled | Items matching a label | Traps with any extraction | Secrets stored | Spans not verbatim or < 8 chars | JSON-only replies |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 25/26 | 31/32 | 0/24 | 0 | 0 | 5/5 |
| 2 | 25/26 | 34/36 | 0/24 | 0 | 0 | 5/5 |
| 3 | 25/26 | 33/36 | 0/24 | 0 | 0 | 5/5 |

The items that matched no label are all correct additional facts from the same prompts (for example "Prefers dairy-free recipes" next to "Is lactose intolerant"), so the label-match rate understates precision. The misses are time-bound plans: the exam date (runs 2 and 3) and the half-marathon commitment (run 1), both `kind: "event"` candidates. The sensitive fact was extracted only because the message asked to remember it; the health, money, religion, politics and home-address traps without a request produced nothing.

### Decision
**Accepted: `claude-haiku-5-5`** is the pinned extractor model (and the judge model when the judge is turned on). Labelling families B and C are not pinned: the owner provided no eval keys (evals.md §1.7), so every gate runs without them. M1 follow-up for suite P: event-kind recall (the two misses above) with the real labelled set.
