#!/bin/bash
# ma-selfcheck.service (root, eval stacks only): run suite S's on-instance checks
# for the pending request. When the request asks to compact first, run ma-maint now, as the
# night after a purge would, so "a purged canary after ma-maint" is checked without waiting
# for 04:15. ma-maint takes the updater's lock and stops and restarts the server itself.
set -euo pipefail

REQUEST=/run/memory-anywhere/selfcheck/request.json

if [ -f "$REQUEST" ] && python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("compact") is True else 1)' "$REQUEST"; then
  echo "ma-selfcheck: compacting first (ma-maint)"
  /usr/local/libexec/memory-anywhere/ma-maint.sh
fi
exec /opt/memory-anywhere/current/bin/memory-anywhere-server selfcheck --config /etc/memory-anywhere/server.toml
