# 0112 Deployment region (Q20) and Litestream on the pinned release (Q21)

Status: accepted (Q20 and Q21)
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

### Context
deployment-aws.md §5.1 configures Litestream 0.5 with a top-level `snapshot:`, one `replica:` with `sse-kms-key-id` and `sync-interval: 1s`, and `meta-path` on tmpfs; §4 `ma-maint` replaces the database during compaction. Q21 checks that this exact file works on the pinned release and that a restore after compaction is exact.

### Method
`spikes/litestream-probe` (a `node:sqlite` stand-in for the server's store with the data-model.md §1 PRAGMAs in aws mode, a purge, and `maint --compact`: checkpoint, `VACUUM INTO`, fsync, zero-overwrite of the old files, rename) shipped in the dev-signed spike release; `probe/q21.sh` run as root on the spike instance through SSM Run Command: create the store with a canary row, start `litestream.service`, scan the data directory and `/run/litestream` every 2 s, attempt an application `wal_checkpoint(TRUNCATE)`, purge the canary and time its removal, run one `ma-maint` cycle, write one more row, `litestream restore` to a fresh path and compare ordered-dump SHA-256s. Litestream 0.5.18 (pins.env), Node 24.22.2, t4g.small, AL2023 arm64, 2026-11-08.

### Result
- **Run 1 failed** ([`q21-run1.txt`](../results/evidence/ADR-0112/q21-run1.txt)): the probe created `store.db` with mode 0640 (SQLite's 0644 minus the unit's umask 007). Litestream 0.5 writes into the database (its `_litestream_seq` table) and could not; the WAL it created (0640, owner `litestream`) then blocked the server user, so purge, checkpoint and compaction failed and the restore found no backup. deployment-aws.md §4 step 7 already requires 0660; the store's creator must set it explicitly before the first WAL exists (SQLite gives `-wal` and `-shm` the database file's mode).
- **Run 2 passed** ([`q21-run2.txt`](../results/evidence/ADR-0112/q21-run2.txt)), store created 0660:

| Check | Result |
| --- | --- |
| Replication with KMS through the gateway endpoint | first 3 objects within 3 s |
| File modes with Litestream running | `store.db` 660 memory-anywhere:ma-data; `-wal`, `-shm` 660 litestream:ma-data |
| Application `wal_checkpoint(TRUNCATE)` while Litestream runs | blocked: `{busy: 1, log: 4, checkpointed: 4}` |
| Purged canary leaves the database file | after 56 s (Litestream's own checkpoint) |
| `ma-maint` cycle (stop, compact, clear `/run/litestream/store`, start) | 1 s; canary absent from the database and WAL; Litestream reported "database behind replica", fetched the latest L0 file and continued; new snapshot after 5 s |
| Restore after compaction plus one more row | 1 s; ordered-dump SHA-256 equal to the live database (`e388ce1d…`) |
| Litestream files under `/var/lib/memory-anywhere` | none (`meta-path` on tmpfs honoured) |
| Peak `/run/litestream` staging | 18,260 bytes |

The canary was not in the WAL when it was purged (it was written before Litestream started, then checkpointed on close), so the WAL clearing time is not measured by this run; the nightly `ma-maint` zeroes the WAL regardless (§4), and run 2 shows it absent after that cycle.

### Decision
**Accepted: config as written.** No key changes, no tmpfs fallback, no `litestream reset`. The 56 s database clearing time replaces "≤ Litestream's checkpoint interval" in deployment-aws.md §5.3 with a measured value at this write volume. M1 requirement (spec-issues.md #14): the server creates `store.db` with mode 0660 before opening it, and `maint --compact` sets 0660 on `store.new.db` before the rename.
