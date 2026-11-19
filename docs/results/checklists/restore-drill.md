# Restore drill

The test: the store survives losing its server. The old instance is replaced by a
new one, which rebuilds the store from the S3 backup. It passes when the rebuilt store is the same
store, bit for bit in its canonical form, and the service is back within 30 minutes.

```
 old instance                    S3 backup (Litestream)           new instance
 ─────────────                   ──────────────────────           ─────────────
 1 pause: server stops,          the last frames arrive
   hash A ──────────────┐
                        │        2 mema deploy --replace-instance
                        │                                    ──► 3 restore, hash B, checks
 terminated by CFN      │                                        4 server starts, healthy
                        └──────────────── A = B ? ───────────────┘
 RTO = healthy time − pause time ≤ 30 min
```

Copy this file to `drill-<date>.md`, fill the blanks, and record only hashes, times and counts: no
store content.

## Before

| Step | Who | Done |
| --- | --- | --- |
| The owner takes an encrypted export (`mema export --out <file>`) and keeps it off the instance | owner | |
| A manifest has been stored since the last release (`aws s3 ls` of the manifest bucket in CloudShell) | owner | |
| `aws sso login --sso-session ma-deploy` on the PC; CloudShell open as `ma-operator` with the reviewed `ma-operator.sh` | owner | |

## Drill

| Step | Command | Result |
| --- | --- | --- |
| 1. Pause writes | CloudShell: `./ma-operator.sh pause` | paused at: ______ · hash A: ______ |
| 2. Replace the instance | PC: `mema deploy aws --update --replace-instance --release <current version> --stage prod` (owner types `y`) | new instance id: ______ |
| 3. Restore and checks | CloudShell: `./ma-operator.sh store-hash` | restored at: ______ · hash B: ______ |
| 4. Healthy | the deploy prints `Healthy: <version>` | healthy at: ______ |
| 5. Restored state | admin UI: alert `restored`; apps still connected (grants kept for reason `lost`) | |

## Result

| Check | Pass when | Result |
| --- | --- | --- |
| Same store | hash A = hash B | |
| RTO | healthy − paused ≤ 30 min | ______ min |
| Restore checks | integrity, schema, event chain, manifest (the journal shows no `RestoreCheckFailed`) | |
| Recall | a recall from one app returns a memory saved before the pause | |

If a step fails: `./ma-operator.sh resume` brings the old instance back while it still exists; after
it is terminated, the owner's export and `./ma-operator.sh restore --reason lost` (§5.5) remain.
