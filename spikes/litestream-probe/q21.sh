#!/bin/bash
# Q21 on the spike instance (m0-spike.md), run as root through SSM Run Command from the release:
#   bash /opt/memory-anywhere/current/probe/q21.sh
# Uses the exact /etc/litestream.yml of deployment-aws.md §5.1 (written by host/install.sh)
# and litestream.service as installed. Prints one "RESULT key=value" line per measurement.
set -uo pipefail
# shellcheck source=/dev/null
. /etc/memory-anywhere/stack.env

REL=/opt/memory-anywhere/current
NODE=/opt/memory-anywhere/node/bin/node
PROBE="$REL/probe/probe.ts"
DATA=/var/lib/memory-anywhere
DB=$DATA/store.db
CANARY="Q21-CANARY-$(date +%s)"
SCAN_LOG=/var/tmp/q21-scan.log
RESTORE_DIR=/var/tmp/q21-restore

log() { echo "[$(date -u +%T)] $*"; }
result() { echo "RESULT $1=$2"; }
# As the server user, with group-writable files so Litestream (group ma-data) can checkpoint.
probe_as_server() { runuser -u memory-anywhere -- sh -c 'umask 007; exec "$@"' sh "$NODE" "$PROBE" "$@"; }
# Same, with errors folded into the captured result (one line), so a failure is visible in RESULT lines.
probe_result() { probe_as_server "$@" 2>&1 | grep -v "^    at " | tr "
" " "; }
probe_root() { "$NODE" "$PROBE" "$@"; }
present() { if probe_root contains "$1" "$CANARY"; then echo present; else echo absent; fi; }
s3_objects() { aws --region "$MA_REGION" s3 ls "s3://$MA_BACKUP_BUCKET/litestream/store/" --recursive | wc -l; }

result litestream_version "$(litestream version)"
result node_version "$($NODE --version)"

log "0. clean slate"
systemctl stop litestream.service 2>/dev/null
rm -f "$DB" "$DB-wal" "$DB-shm"
aws --region "$MA_REGION" s3 rm "s3://$MA_BACKUP_BUCKET/litestream/" --recursive --quiet
rm -rf "$RESTORE_DIR" "$SCAN_LOG"

log "1. create the store (data-model.md §1 PRAGMAs, aws mode) and 200 rows, one holding the canary"
probe_as_server init "$DB"
probe_as_server write "$DB" 200 "$CANARY"
result db_file_mode "$(stat -c '%a %U:%G' "$DB")"

log "2. scan the data directory and the tmpfs metadata directory every 2 s"
(
  while :; do
    find "$DATA" -mindepth 1 -printf 'F %p\n'
    echo "M $(du -sb /run/litestream 2>/dev/null | cut -f1)"
    sleep 2
  done
) >"$SCAN_LOG" 2>/dev/null &
SCAN=$!

log "3. start Litestream and wait for the first replication"
t0=$(date +%s)
systemctl start litestream.service
n=0
for _ in $(seq 1 90); do
  n=$(s3_objects)
  [ "$n" -gt 0 ] && break
  sleep 2
done
result replicated_objects "$n"
result first_replication_s "$(($(date +%s) - t0))"
sleep 5

log "4. application checkpoint while Litestream holds its read transaction"
result store_file_modes "$(stat -c "%n %a %U:%G" "$DB" "$DB-wal" "$DB-shm" 2>&1 | sed "s|$DATA/||" | tr "
" ";")"
result app_checkpoint_truncate_while_litestream_runs "$(probe_result checkpoint "$DB")"

log "5. purge the canary (no application checkpoint: aws mode) and time until it leaves the files"
result purged_rows "$(probe_result purge "$DB" "$CANARY")"
tp=$(date +%s)
db_cleared=-1
wal_cleared=-1
for _ in $(seq 1 90); do
  el=$(($(date +%s) - tp))
  if [ "$db_cleared" -lt 0 ] && [ "$(present "$DB")" = absent ]; then db_cleared=$el; fi
  if [ "$wal_cleared" -lt 0 ] && [ "$(present "$DB-wal")" = absent ]; then wal_cleared=$el; fi
  if [ "$db_cleared" -ge 0 ] && [ "$wal_cleared" -ge 0 ]; then break; fi
  sleep 2
done
result canary_left_db_file_after_s "$db_cleared"
result canary_left_wal_file_after_s "$wal_cleared (-1 = still there after 180 s)"
result wal_size_bytes "$(stat -c %s "$DB-wal" 2>/dev/null || echo 0)"

log "6. one ma-maint cycle (deployment-aws.md §4): stop Litestream, compact, clear metadata, start"
tm=$(date +%s)
before_objects=$(s3_objects)
systemctl stop litestream.service
result litestream_runtime_dir_after_stop "$([ -e /run/litestream ] && echo present || echo removed)"
result compact "$(probe_result compact "$DB")"
rm -rf /run/litestream/store
systemctl start litestream.service
result maint_cycle_s "$(($(date +%s) - tm))"
result canary_after_maint_db "$(present "$DB")"
result canary_after_maint_wal "$(present "$DB-wal")"
for _ in $(seq 1 60); do
  [ "$(s3_objects)" -gt "$before_objects" ] && break
  sleep 2
done
result new_snapshot_after_maint_s "$(($(date +%s) - tm))"

log "7. one more row, then wait for it to replicate (sync-interval 1s)"
result write_after_maint "$(probe_result write "$DB" 1)(empty = ok)"
sleep 15
live=$(probe_as_server dump-hash "$DB")

log "8. litestream restore to a fresh path"
install -d -m 0700 "$RESTORE_DIR"
tr=$(date +%s)
if litestream restore -config /etc/litestream.yml -o "$RESTORE_DIR/store.db" "$DB"; then
  result restore_s "$(($(date +%s) - tr))"
  restored=$(probe_root dump-hash "$RESTORE_DIR/store.db")
else
  restored="restore-failed"
fi
result live_dump_sha256 "$live"
result restored_dump_sha256 "$restored"
result restore_matches "$([ "$live" = "$restored" ] && echo yes || echo no)"

log "9. what was on the volume, and peak tmpfs staging"
kill "$SCAN" 2>/dev/null
result files_seen_under_data_dir "$(grep '^F ' "$SCAN_LOG" | cut -c3- | sed "s|$DATA/||" | sort -u | tr '\n' ' ')"
result litestream_files_on_volume "$(grep '^F ' "$SCAN_LOG" | cut -c3- | grep -i -E 'litestream|\.ltx' | sort -u | tr '\n' ' ')(empty = none)"
result peak_run_litestream_bytes "$(grep '^M ' "$SCAN_LOG" | cut -c3- | sort -n | tail -n1)"
echo "--- litestream journal (last 25 lines)"
journalctl -u litestream.service --since "-30min" --no-pager -o cat | tail -n 25
rm -rf "$RESTORE_DIR"
