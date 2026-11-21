#!/bin/bash
# manifest-at.sh <restore point or ""> <out file>: run as root before a restored start
# (deployment-aws.md §5.5), by host/release/first-store.sh and `ma-operator.sh restore`.
# Writes the newest daily manifest stored no later than the restore point (with "", the newest
# of all) to <out file>, or `null` when none was stored by then. The server checks the
# restored event chain against it (packages/server/src/ops/manifest.ts). If the bucket cannot
# be read the script fails, and so does the restore: it never starts without the check.
set -euo pipefail

TO=${1?usage: manifest-at.sh <restore point or ""> <out file>}
OUT=${2:?usage: manifest-at.sh <restore point or ""> <out file>}
# shellcheck source=/dev/null
. "${MA_STACK_ENV:-/etc/memory-anywhere/stack.env}" # tests point MA_STACK_ENV elsewhere
# Named like the backup bucket (deploy/aws/lib/names.ts), as in libexec/outbox.sh.
BUCKET=${MA_BACKUP_BUCKET/-backup-/-manifest-}

listing=$(aws --region "$MA_REGION" s3api list-objects-v2 --bucket "$BUCKET" --prefix manifests/ --output json)
key=$(python3 -c '
import json, re, sys
from datetime import datetime

def at(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

to = sys.argv[1]
items = [i for i in (json.loads(sys.stdin.read() or "{}").get("Contents") or [])
         if re.fullmatch(r"manifests/manifest-\d{4}-\d{2}-\d{2}\.json", i["Key"])]
if to:
    items = [i for i in items if at(i["LastModified"]) <= at(to)]
print(max(items, key=lambda i: at(i["LastModified"]))["Key"] if items else "")' "$TO" <<<"$listing")

tmp="$OUT.tmp"
if [ -n "$key" ]; then
  aws --region "$MA_REGION" s3 cp --only-show-errors "s3://$BUCKET/$key" "$tmp"
  echo "manifest-at.sh: checking the restore against ${key#manifests/}"
else
  echo null >"$tmp"
  echo "manifest-at.sh: no manifest stored by the restore point; the chain check runs without one"
fi
if [ "$(id -u)" = 0 ]; then chown memory-anywhere:ma-data "$tmp"; fi
chmod 0660 "$tmp"
mv "$tmp" "$OUT"
