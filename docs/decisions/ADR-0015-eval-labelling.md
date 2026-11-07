# 0015 Eval labels: public items plus two non-Claude model families, owner spot-check

Status: accepted
Date: 2026-11-07 (revised in round 3)

## Context
Owner decision: public benchmark items, labels from a second model family, and a 50-item owner spot-check. Review: the labelling family must differ from the extractor/judge family and from the implementing agent (review2-architecture N27).

## Decision
Family A = Claude (implementer and, in the owner deployment, extractor). Family B (OpenAI) generates scenarios; family C (Google) labels; or B and C swapped per dataset, recorded per dataset. The owner spot-checks 50 items in total, as decided, spread across the labelled test sets; agreement and κ are reported. Public items (LongMemEval, MemoryAgentBench, BEAM) are used where they fit.

Cross-vendor generation and labelling are optional: they use the owner's personal API keys under a hard $30 eval cap, separate from the $20 import budget. Without keys, gates use public items and mechanical labels, Claude runs through Claude Code headless on the subscription, and author-labelled results are reported but never gated (evals.md §1, §4).

## Consequences
The owner's labelling decision is met when keys are provided; without them the benchmark is weaker but honest, and says so in each result file (`labels`).
