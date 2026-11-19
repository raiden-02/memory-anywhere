# 0022 Eval budget: optional personal keys, $30 hard cap, no-key path for every gate

Status: accepted
Date: 2026-11-07

## Context
The v3 eval plan needed OpenAI and Google API keys in M0 with no budget or owner step (round-3 audit B4). The owner's default: cross-vendor runs are optional, use personal API keys, and have a hard $30 cap separate from the $20 import budget; M0 must pass without them.

## Decision
- `MA_EVAL_ANTHROPIC_API_KEY`, `MA_EVAL_OPENAI_API_KEY`, `MA_EVAL_GOOGLE_API_KEY` are optional; `MA_EVAL_USD_CAP` defaults to and cannot exceed $30. The harness estimates every call and refuses one that would cross the cap.
- M0's retrieval baselines and model choice use a public LongMemEval-S subset (public labels, no model calls). seed-r is built in M1.
- Claude-driven suites run through Claude Code headless on the owner's subscription.
- Gates use public or mechanical labels only; author-labelled results are reported, never gated.

## Consequences
Without keys, the benchmark lacks cross-vendor rows and independent labels for authored items; the report says so. With keys, the owner's labelling decision (ADR-0015) is met within $30.
