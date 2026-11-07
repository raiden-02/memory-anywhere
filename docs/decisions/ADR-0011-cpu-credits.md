# 0011 t4g.small with standard CPU credits

Status: accepted
Date: 2026-11-07

## Context
The architecture review proposed unlimited credits so bulk imports are not throttled (N19). The security review flagged unlimited mode as a denial-of-wallet path under floods (W/D1).

## Decision
`CreditSpecification: standard`. Floods throttle instead of billing. Imports are batch jobs that can run slowly; t4g.small earns 24 credits/hour, and an import of a few thousand items is bounded by the LLM, not by CPU.

## Consequences
Bulk re-embedding may take longer. M4 measures it; if it exceeds 2 hours, the owner may switch to unlimited for the duration of the job through a stack parameter (`mema deploy aws --update`), and back afterwards.
