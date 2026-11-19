# 0003 Stated preferences are recalled at once but enter the profile only at T0/T1

Status: accepted
Date: 2026-11-07 (revised in round 3)

## Context
The architecture review (N3) wanted preferences active from T1 and rendered in the profile with a "stated in <client>" tag. The security review (P1, D-1, D-2) wanted `preference` gated like `instruction`: pending_review until the owner approves, because the profile is loaded everywhere and one injected "preference" would become a standing instruction. The owner wants preferences saved reliably.

## Options
1. Active and profiled from T1/T2 (N3).
2. pending_review until approved (D-1).
3. Active at T2 (recalled by query, e.g. "preferred answer length"), but profiled only at T0/T1; action-like text is an `instruction` and goes to review.

## Decision
Option 3. Preferences stay useful immediately through recall and session-start, never vanish into an unrecalled queue, and cannot enter the always-loaded profile without the owner's confirmation (one tap in the admin UI or `mema review --approve`, on the `preference_confirm` review item that every unconfirmed preference creates; or an elicitation on clients that support it). Confirmation writes a new version at T0 (`change_kind = confirmation`). The deterministic action-instruction screen (memory-policy.md §3.2) separates "how to answer me" from "do X".

## Consequences
Key profile facts (name, title, employer, city, home country, timezone, education, OS) may enter the profile at T2. This deviates from review2-security D-2 ("nothing at T2 in the profile"): until a client supports verified elicitation, no chat save reaches T1, and a profile without basic facts would make the memory far less useful. These rows are data from a fixed attribute list, escaped and framed as notes. A T2 save cannot replace a T0/T1 value, and (rounds 3–4) a T2 change to a key-fact slot whose current T2 value came from a **different** client becomes contested instead of an update (a T2 save over an imported T3 value still updates it), shown in the profile as `unconfirmed: A / B` (write-path.md §8 rule 4a). So one client, however injected, cannot silently rewrite the identity every other client loads.
The profile shows "M stated preferences await confirmation". Suite P measures how often confirmed preferences match what the owner wanted.
