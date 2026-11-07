# 0112 Deployment region (Q20) and Litestream on the pinned release (Q21)

Status: proposed (Q20 decided; Q21 pending)
Date: 2026-11-07
Milestone: M0
Question: Q20, Q21

## Q20 Region by round-trip time

### Context
The region is fixed for the `prod` stack (deployment-aws.md §11), and the one-time bootstrap, the `~/.aws/config` region line and the spike deploy all need it, so Q20 runs first in M0 (m0-spike.md §4). Rule: lowest median of 50 TLS handshakes from the owner's PC to `us-east-1`, `us-east-2` and `us-west-2` (control); ties go to `us-east-1`.

### Options
1. Take the literal winner of one 50-handshake run.
2. Define "tie" statistically, as ADR-0005 does for embedding models ("paired CI includes 0"), over pooled runs.

### Method
- `spikes/rtt/src/rtt.ts measure --n 50`: each sample is a fresh TCP connect plus TLS handshake (no session resumption) to `s3.<region>.amazonaws.com:443`, timed from `connect()` to `secureConnect`; DNS resolved once per region beforehand; regions interleaved round-robin.
- Owner's PC: Windows 11 Home 10.0.26200 x64, home network, Node v24.22.2. Two runs, a few minutes apart, on 2026-11-07.
- `rtt.ts decide` pools both runs and computes, for each region, the 95% percentile-bootstrap CI of median(region) − median(fastest) (10,000 resamples, seed 1234).

### Result
Evidence: [`docs/results/evidence/ADR-0112/`](../results/evidence/ADR-0112/) (`q20-run1.json`, `q20-run2.json`, `q20-decision.json`).

| Run | us-east-1 median | us-east-2 median | us-west-2 median | Literal winner |
| --- | --- | --- | --- | --- |
| 1 (n = 50 each) | 94.3 ms | 93.0 ms | 154.5 ms | us-east-2 |
| 2 (n = 50 each) | 94.3 ms | 94.8 ms | 154.5 ms | us-east-1 |
| Pooled (n = 100 each) | 94.3 ms | 93.8 ms | 154.5 ms | us-east-2 |

Pooled difference to the fastest (us-east-2): us-east-1 +0.48 ms, 95% CI [−0.01, 0.97] → **tied**; us-west-2 +60.72 ms, CI [60.06, 61.48] → not tied.

The two runs disagreed on the winner, so the spec's rule was ambiguous ("tie" was undefined). The owner chose the statistical definition (option 2) on 2026-11-07.

### Decision
**us-east-1.** A region ties with the fastest when the 95% bootstrap CI of the median difference includes 0; ties go to us-east-1 (implemented and tested in `spikes/rtt/src/choose.ts`). us-east-1 and us-east-2 are indistinguishable from this PC (≈ 94 ms; under 1 ms apart), and us-west-2 is about 61 ms slower. No spec section changes; deployment-aws.md §11 now resolves to us-east-1. The deploy profile gets `region = us-east-1`.

### Consequences
Prices in deployment-aws.md §10 (us-east-1 on-demand) apply as written. If the owner moves, the region still cannot change after M2 without moving the store (topology-and-ipc.md §7). The first run's literal result is recorded in `docs/results/negative-results.md`.

## Q21 Litestream v0.5 on the spike instance

Pending (M0 phase P8).
