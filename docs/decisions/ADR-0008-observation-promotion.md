# 0008 Observation promotion: two distinct sessions; chat sessions approximated by client and a 6-hour gap

Status: accepted
Date: 2026-11-07

## Context
v2 said both "comes up again in another session" and "the third mention gets in" (review2-architecture N15, contradiction 8). The fact-check build spec proposed "≥ 2 sessions OR ≥ 3 mentions" (M1.9). Chat apps send no conversation id.

## Options
1. 3 mentions across 2 sessions.
2. 2 distinct sessions, any number of mentions.
3. 2 sessions or 3 mentions.

## Decision
Option 2. Three mentions in one conversation is dwelling, not recurrence, and is the cheapest thing for an injected page to fake; two separate sessions is the signal that something is a lasting part of the user's life. Chat "session" = same client at least 6 hours apart, or a different client. Floored mentions (Gemini, Grok, generic clients) do not count on their own.

## Consequences
One-off tastes need a second conversation to be remembered. Suite P measures promotion precision and recall; `promote_min_sessions` and `chat_session_gap_hours` change only with a policy version.
