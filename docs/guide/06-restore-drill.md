# 06 · Restore drill

At the end of this chapter you can bring your store back from its backups, and prove that what came back
is the same store, change for change.

This chapter is about the store on your own AWS ([04](04-your-own-aws.md)); local mode has no backups
but the exports you take.

## 1. When you would restore

| What happened | What to do |
| --- | --- |
| The server machine is gone, broken, or will not start | replace the machine (§4): the new one rebuilds the store from the backup |
| You need the store as it was at an earlier moment, or you think someone got in | restore to a point in time (§5) |
| One app saved nonsense for an afternoon | not a restore: **Apps →** that app **→ Revert** on the admin page undoes just its changes |
| You want to practise, or prove the backups work | the drill (§4), with a pause first so nothing is lost |

Practise before you need it. A backup you never restored is a hope, not a backup.

## 2. What the backups are

Three copies, each for a different failure:

```
              7 days ago                                                 now
 replica      ═══════════════════════════════════════════════════════════▶  every change, about 1 s behind
 snapshots    ●        ●        ●        ●        ●        ●        ●         the whole disk, daily, 7 kept
 manifests  ◆ ◆        ◆        ◆        ◆        ◆        ◆        ◆         one line a day, locked 90 days
```

**The replica** is a carbon copy that fills in as you write. A program on the server (Litestream) sends
every change of the store's database to an S3 bucket about a second after it happens. A restore can
rebuild the store as it was at any moment in about the last 7 days, and losing the machine loses at
most the last second.

**The snapshots** are daily copies of the server's whole disk, taken by AWS at 05:00 UTC; the last 7 are
kept. They are a further fallback that AWS restores, not `mema`.

**The manifests** prove the history was not rewritten. Every change the store records carries the
fingerprint (a hash) of the change before it, like a chain whose every link is shaped by the one before:

```
 change 1 ──▶ change 2 ──▶ change 3 ──▶ … ──▶ change n        fingerprint of change n = the head
                                                    ▲
 each day, in a locked drawer:  "n changes; head = 9f3c…"
```

Alter any old change and every later fingerprint changes, so the head no longer matches. Once a day the
server writes the count and the head to a separate bucket under **Object Lock**: for 90 days nobody can
change or delete it, not you, not the account's root user. Each day the server first checks that its
own chain still reaches the last locked head; if not, it emails you (`manifest_mismatch`, "The store's
history differs from its locked record") and writes nothing. A restored store must reach the locked head
too, or it does not start.

To compare two stores you need one more fingerprint: the **store hash**, a hash of the store's whole
content written in a fixed order. Sign-ins and logs are left out, so the same memories, versions and
history always give the same hash, on any machine.

## 3. Before you start

1. Take an encrypted export and keep it off the server, as a last resort that needs no AWS at all. It
   needs an export key registered on the admin page's **Exports** tab:

   ```shell
   mema export --out memory-export.age
   ```

2. On the PC, sign in as `ma-deploy` ([04 §5](04-your-own-aws.md)).
3. In a private window, open CloudShell as `ma-operator` with the `ma-operator.sh` of your version
   ([04 §8](04-your-own-aws.md)).

## 4. The drill: replace the machine

The drill replaces the server machine on purpose, exactly as you would after losing it, and checks that
the store that comes back is the one that left.

1. **Pause the store** (CloudShell). The server stops, the last changes reach the replica, then the
   replica stops:

   ```bash
   ./ma-operator.sh pause
   ```

   It prints `paused at <time>` and `store hash <hash A>`. Write hash A down. Until step 3, apps get
   errors and coding tools keep their saves in their spool.

2. **Replace the machine** (PC). `--replace-instance` builds a new machine even though nothing else
   changed; the release is the one the server already runs:

   ```shell
   mema deploy aws --stage prod --update --replace-instance --release <version>
   ```

   It says `This builds a new instance (generation <n>); it restores the store from the backup and the
   old one is terminated.` Answer `y`. The new machine finds no store on its disk, restores the latest
   replica, checks it, and starts. No DNS change is needed: the address stays the same.

3. **Compare the hashes** (CloudShell):

   ```bash
   ./ma-operator.sh store-hash
   ```

   It prints two lines: `restored <hash B>`, computed right after the restore and before the server
   started, and `now <time> <hash>`. **Hash B must equal hash A.** The `now` hash differs once the
   server runs, because a restored server rotates its own secrets and ends sessions, and records that.

4. **Healthy** (PC): the deploy prints `Healthy: <version>`.

5. **Check from an app**: the admin page shows the alert "The store was restored from a backup"; ask
   any connected app to recall something you saved before the pause.

If a step fails while the old machine still exists, `./ma-operator.sh resume` starts it again. After it
is gone, §5 and your export remain.

## 5. Restore to a point in time

On a running server, CloudShell can restore the store to any moment the replica covers:

```bash
./ma-operator.sh restore --reason lost --to 2026-11-08T10:00:00Z
```

Leave out `--to` for the latest state. The server stops, the current store is moved aside (kept for 24
hours, then wiped), the replica is restored to that moment, and the server starts again. Use
`--reason compromise` if you think someone got in: then every app connection is revoked and you connect
each app again ([03](03-connect-apps.md)). The same happens with a restore point more than an hour in
the past, since connections changed after it may be ones you no longer trust.

## 6. What a restored server does

Before it serves anything, it checks the database's integrity, its schema version, the whole chain of
changes, and the chain against the locked manifest from no later than the restore point. Any failure
stops it, with the failing check in its log.

Then it rotates its own secrets, signs out every admin session, and closes open approvals and pairing
windows. App connections are kept for `--reason lost` and revoked for `compromise`. The next day's
manifest starts a new series, since the history after the restore point is not the one the old
manifests recorded.

## 7. How long it takes

A measured drill, from pause to healthy:

```
 0:00                        4:16   5:24           7:42    9:00
 ●───────────────────────────●──────●──────────────●───────●───▶ minutes
 │                           │      │              │       └ healthy
 │                           │      │              └ store restored from the replica, hash B = hash A
 │                           │      └ the new machine is running
 │                           └ the deploy starts replacing the machine
 └ pause: writes stop, hash A
```

Nine minutes, against a target of thirty; from the start of the replacement to healthy took under five.
If you tightened your CAA record to Let's Encrypt's account (`./ma-operator.sh acme-account`), relax it
to `0 issue "letsencrypt.org"` first: the new machine opens a new account and could not get a
certificate until you do.

Next: [the course map](../README.md)
