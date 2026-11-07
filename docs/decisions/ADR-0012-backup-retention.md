# 0012 Backup retention and the purge guarantee: 30 days

Status: accepted
Date: 2026-11-07 (revised in round 3)

## Context
v2 gave no numbers (review2-architecture N20; review2-security X2). The architecture review proposed Litestream 7 d, S3 noncurrent 7 d, EBS 7 snapshots, weekly exports kept 4 (purge within 14 d, exports 28 d). The security review proposed noncurrent 30 d (purge within 37 d).

## Decision
Litestream snapshot retention 168 h; S3 noncurrent versions 14 d; EBS snapshots 7; no scheduled export to S3 (removed in round 3 as a third backup that only lengthened purge exposure). On-instance copies (WAL, Litestream staging, pre-update, pre-migration and pre-restore copies) are cleared within 48 hours (deployment-aws.md §5.3). Purge guarantee: every AWS backup within 30 days (computed maximum 22). 14 days of noncurrent versions keeps two weeks of protection against an overwrite or deletion by a compromised instance (which cannot delete versions), while keeping the guarantee short.

## Consequences
The README states the three numbers (live file at once, every file on the instance within 48 hours, backups within 30 days). The oldest restore point is about 8 days; there is no longer-term backup.
