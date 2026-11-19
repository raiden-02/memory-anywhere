# 0116 Daily manifests in a locked bucket, written and checked through the outbox

Status: accepted
Date: 2026-11-17
Milestone: M4

## Context
The event chain makes every change to the store tamper-evident, but only against a copy of its head kept where an
attacker who controls the instance cannot change it. The M4 plan asked for an Object Lock manifest bucket and checks
against it, daily and on restore (deployment-aws.md §5.4–5.5). The server has no AWS credentials: everything it sends
to AWS goes through the outbox, which a separate host user (`ma-aws`) drains (§4). The owner allowed the server to read
the manifest bucket (2026-11-15).

```
 server (no AWS keys)              outbox (ma-aws)                      manifest bucket (Object Lock)
 1 manifest-fetch-<ulid> ───────►  manifest-at.sh: newest stored  ────  manifests/manifest-<date>.json
                                   no later than now (LastModified)
 2 inbox/drop/manifest-<ulid> ◄──  the manifest, or null
 3 check: event no. event_count
   has hash event_chain_head?
   no → alert manifest_mismatch, stop
 4 manifest-<today>.json ────────►  upload (today's UTC date only)
```

## Options
1. Give the server credentials for the bucket: simplest, but an attacker on the instance could then read and write it
   with the server's rights, and the server would hold AWS keys for the first time.
2. Fetch and store through the outbox, as backups already go. Chosen.
3. Check only on restore: misses a history rewritten on a running instance until the next restore.

## Decision
The daily job (05:00 owner time, aws mode) fetches the newest stored manifest through the outbox, checks that the live
chain still reaches its head at its position, and stores today's. A mismatch raises `manifest_mismatch` and writes
nothing, so the last locked manifest remains the last good history. A restore fetches the manifest stored no later than
the restore point (`manifest-at.sh`, by S3's LastModified, not by the name) and refuses to start the
server unless the restored chain reaches it. After restored state or a store import the next job starts a new series
without comparing (`meta.manifest_restart`). The bucket name is derived on the host from the backup bucket's, so
adding it did not change the instance's user data or replace the instance. Prod: Object Lock compliance mode, 90 days,
retained on stack deletion; other stages: no lock.

## Consequences
- The first manifest was stored on 2026-11-17 and the restore drill checked the store against it.
- Within a day a rewrite is not detected; the check is daily.
- A locked manifest cannot be deleted for 90 days, even by the owner, and deleting the prod stack keeps the bucket.
- The operator role reads the bucket; only the instance writes it.
