# 0111 Gemini API as an eval harness (Q18)

Status: rejected (not run: no Google eval key)
Date: 2026-11-08
Milestone: M0
Question: Q18

## Context
evals.md §8.2 would drive Gemini rows of suites A and P (model stage) through the Gemini API, with the harness acting as the MCP client (it lists the server's tools, passes them as function declarations and executes the calls). m0-spike.md Q18 makes this optional and conditional: it runs only if the owner provides a Google eval key (`MA_EVAL_GOOGLE_API_KEY`, evals.md §1.7), with 20 suite A prompts inside the eval cap.

## Options
1. Run Q18 with an owner-provided Google key and use the API for Gemini rows.
2. No key: Gemini rows are manual only (the Q18 fail branch).

## Method
None. The owner chose to run M0 without eval API keys ("No eval API keys. Every gate must pass without them."), so no Google key exists and the 20-prompt run was not attempted.

## Result
Not run. No spend (`docs/results/eval-spend.json` stays at $0).

## Decision
**Rejected for v1 by the fail branch: Gemini rows are manual only.** Suites A and P report Gemini from the Gemini app by hand (dated manual checklist, evals.md §8.2 last paragraph) and mark those rows "manual". No spec text changes: evals.md already lists the API path as optional. If the owner later provides a Google key, Q18 is run as written and this ADR is superseded.

## Consequences
Gemini results in suites A and P are smaller (manual runs) and not repeated ≥ 3 times automatically; they are reported as manual rows with their n. No milestone gate depends on them (evals.md §10).
