# 0007 LLM provider and pinned models

Status: proposed (ids decided in M0 Q16)
Date: 2026-11-07

## Context
v2 used an LLM for slot proposal, extraction, judging and section naming without host, key, timeout or fallback (review2-architecture N9).

## Decision
All calls run on the server through one adapter (write-path.md §6.2). Owner deployment: provider `anthropic`, a small fast model pinned by dated id; judge off until suite P shows it helps; $1/day live cap, $20 import cap. Labelling families B and C (evals) come from OpenAI and Google, never Anthropic and never the extractor family. No-LLM mode is fully defined and tested.

## Consequences
Model ids are part of every cache key. Changing a model is a policy-version change and re-runs suite P.
