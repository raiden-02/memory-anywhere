#!/bin/bash
# ma-maint.service (root), started by ma-maint.timer at 04:15 owner local time
# (deployment-aws.md §4). It compacts the store when a purge left the flag
# maint/purge-pending, and every Sunday regardless, so no purged block stays in
# the database file or in later EBS snapshots:
#
#   stop server and Litestream → maint --compact (VACUUM INTO, zero the old files,
#   rename) → clear Litestream's metadata → start Litestream (fresh snapshot) and
#   the server → delete the flag
#
# Requests in the minute or two it takes get STORE_UNAVAILABLE; coding tools spool.
set -euo pipefail
umask 007

# shellcheck source=/dev/null
. /etc/memory-anywhere/stack.env

DATA=/var/lib/memory-anywhere
FLAG="$DATA/maint/purge-pending"
SERVER=/opt/memory-anywhere/current/bin/memory-anywhere-server

log() { echo "ma-maint: $*"; }

# The updater's lock: never in parallel with an update, which also stops and starts
# the server. The updater skips its run while this holds it.
exec 9>/run/ma-updater.lock
flock -w 600 9 || { log "an update is still running; trying again tomorrow"; exit 1; }

weekday=$(TZ="${MA_OWNER_TZ:-UTC}" date +%u) # 7 = Sunday, in the owner's time zone
if [ ! -f "$FLAG" ] && [ "$weekday" != 7 ]; then
  log "nothing to do (no purge since the last run, not Sunday)"
  exit 0
fi
if [ ! -f "$DATA/store.db" ]; then
  log "no store yet"
  exit 0
fi

log "compacting the store (${FLAG##*/}: $([ -f "$FLAG" ] && echo present || echo absent), weekday $weekday)"
systemctl stop memory-anywhere.service litestream.service
# Whatever happens below, the server and Litestream come back.
trap 'systemctl start litestream.service memory-anywhere.service' EXIT

runuser -u memory-anywhere -- "$SERVER" maint --compact --config /etc/memory-anywhere/server.toml
# Positions recorded for the replaced file must not be resumed (§4); systemd already
# removed /run/litestream when the unit stopped, and this makes sure.
rm -rf /run/litestream/store
rm -f "$FLAG"
log "done"
