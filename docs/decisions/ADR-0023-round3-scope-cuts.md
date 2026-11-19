# 0023 Round-3 scope cuts, and what was kept

Status: accepted
Date: 2026-11-07

## Context
The round-3 audit listed ten over-engineering items for a one-owner project. Each cut is applied unless it would break an owner requirement.

## Decision

| # | Item | Decision |
| --- | --- | --- |
| 1 | Two OAuth spikes in M0 | Cut: node-oidc-provider only; Better Auth only if a conformance test fails (ADR-0004) |
| 2 | Weekly age export to S3 | Cut: on-demand `mema export` only (ADR-0012) |
| 3 | Object-Lock manifest bucket | Deferred to M4; the event hash chain stays from M1 |
| 4 | Local + tunnel mode | Cut to a README note. **Kept:** local-only mode, because the owner requires it for other users (topology-and-ipc.md §1) |
| 5 | `search`/`fetch` aliases | Cut |
| 6 | Debug plaintext logging | Cut |
| 7 | Optional projections and managed-block hashing | Deferred (ADR-0009). **Kept:** the policy-only Cursor repo rule, because Cursor may not pass server instructions (M0 Q05) and it carries no memory content |
| 8 | 22 step-up CLI admin commands | Cut to seven (`enable`, `disable`, `project track`, `project add`, `export`, `import`, `review`); the rest are in the admin UI. **Kept:** `review` in the CLI, so preference and project confirmations work without the browser |
| 9 | Eval sizes at M1/M2 | Cut to smaller gate sizes with honest intervals; full sizes, ablation and the mem0 and mcp-memory-service baselines move to the M5 report. **Kept:** both external baselines, because the owner decided they run; owner spot-check reduced to the decided 50 items in total |
| 10 | Section-threshold calibration in M1 | Deferred: fixed 0.60 until real data exists after M3. **Kept:** automatic dynamic sections, because the owner decided them (ADR-0018) |

## Consequences
Less code before M2, fewer approvals, and no third backup to purge. M5 carries more of the benchmark work.
