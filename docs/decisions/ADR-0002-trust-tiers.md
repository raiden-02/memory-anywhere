# 0002 Trust tiers come from the channel; T1 needs a human confirmation the server can see

Status: accepted
Date: 2026-11-07

## Context
v2's T1 ("user-stated") rested on model-supplied `user_words` (review2-architecture N5, contradiction 5; review2-security D-1, P1). The architecture review proposed T1v (user_words found in the hook's prompt log) and T1c (chat claim, unverifiable). The security review proposed T1 only for a confirmation the server can verify, and T2 for every other remote save.

## Options
1. T1v/T1c split (architecture N5): verified substring of a prompt raises the tier.
2. T1 only via client-rendered elicitation on clients proven to route it to the human (security D-1).

## Decision
Option 2. A prompt can contain pasted text the user did not write, so a substring match proves the words were in a prompt, not that the user means them. The prompt-log check is kept, but only to discard invented `user_words` (write-path.md §4 step 5). Tiers: T0 owner, T1 elicitation-confirmed, T2 all other saves, T3 imports (data-model.md §7).

## Consequences
Until M0 Q09 shows a client renders elicitation to the human, no client save reaches T1; preferences enter the profile only after the owner confirms them (ADR-0003). This is a usability cost accepted for integrity of the always-loaded profile.
