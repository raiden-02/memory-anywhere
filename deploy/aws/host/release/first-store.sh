#!/bin/bash
# host/first-store.sh <release dir>: run as root by ma-updater when the instance has no
# store.db (deployment-aws.md §4 step 8). If the backup bucket holds a replica, Litestream
# restores it and the server starts in restored state (§5.5); otherwise `init` creates a new
# store. `init` also downloads and checks the embedding model, so it runs in both cases.
set -euo pipefail

REL=${1:?usage: first-store.sh <release dir>}
DATA=/var/lib/memory-anywhere
CONFIG=/etc/memory-anywhere/server.toml
log() { echo "first-store.sh: $*"; }

if runuser -u litestream -- /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DATA/store.db" &&
  [ -f "$DATA/store.db" ]; then
  chown memory-anywhere:ma-data "$DATA/store.db"
  chmod 0660 "$DATA/store.db"
  printf '{"reason":"lost","to":""}\n' >"$DATA/maint/restored"
  chown memory-anywhere:ma-data "$DATA/maint/restored"
  chmod 0660 "$DATA/maint/restored"
  log "restored the store from the backup; the server starts in restored state"
fi
runuser -u memory-anywhere -- "$REL/bin/memory-anywhere-server" init --config "$CONFIG" >/dev/null
log "store ready"
