#!/bin/bash
# memory-anywhere-outbox.service (user ma-aws): act on each file the server wrote
# to /run/memory-anywhere/outbox, by name prefix, then delete it (deployment-aws.md §4).
# The server never holds AWS credentials; this fixed script is its only way out.
set -uo pipefail
umask 007
OUTBOX=/run/memory-anywhere/outbox
DROP=/run/memory-anywhere/inbox/drop
# The manifest bucket is named like the backup bucket (deploy/aws/lib/names.ts); deriving it keeps
# stack.env, and so the instance's user data, unchanged.
MANIFEST_BUCKET=${MA_BACKUP_BUCKET/-backup-/-manifest-}
aws_() { aws --region "$MA_REGION" "$@"; }
log() { echo "outbox: $*"; }

# handle <file> <name>: returns non-zero if any step fails. Steps are chained with
# && because `set -e` does not apply inside a function called as a condition.
handle() {
  local f=$1 name=$2 id ulid json text
  case "$name" in
    setup-token)
      json=$(python3 -c 'import json,sys; print(json.dumps({"Value": open(sys.argv[1]).read()}))' "$f") &&
        aws_ ssm put-parameter --name "$MA_PREFIX/setup-token" --type SecureString --overwrite --cli-input-json "$json" >/dev/null &&
        log "stored setup-token" ;;
    setup-token.delete)
      aws_ ssm delete-parameter --name "$MA_PREFIX/setup-token" >/dev/null 2>&1
      log "deleted setup-token (or it was already gone)" ;;
    alert-*.json)
      id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$f") &&
        [[ "$id" =~ ^[a-z_]{1,40}$ ]] &&
        aws_ sns publish --topic-arn "$MA_TOPIC_ARN" --subject "memory-anywhere $MA_STAGE: $id" --message "file://$f" >/dev/null &&
        log "published alert $id" ;;
    digest-*.json)
      # The daily digest (operations.md §2): kinds, subjects (ids) and counts, never content.
      [[ "$name" =~ ^digest-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$ ]] || { log "ignored a malformed digest name"; return 1; }
      text=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
lines = ["memory-anywhere digest for " + d["date"] + ": " + str(len(d["alerts"])) + " item(s).", ""]
for a in d["alerts"]:
    lines.append("- " + a["kind"] + (" (" + a["subject"] + ")" if a["subject"] else "") + ": " + str(a["count"]) + " time(s), last " + a["last_at"])
lines += ["", "Open the admin UI (System) for details."]
print("\n".join(lines))' "$f") &&
        aws_ sns publish --topic-arn "$MA_TOPIC_ARN" --subject "memory-anywhere $MA_STAGE: daily digest" --message "$text" >/dev/null &&
        log "published the digest" ;;
    acme-account-uri)
      aws_ ssm put-parameter --name "$MA_PREFIX/acme/account-uri" --type String --overwrite --value "$(cat "$f")" >/dev/null &&
        log "stored acme account uri" ;;
    fetch-*)
      ulid=${name#fetch-}
      [[ "$ulid" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]] || { log "ignored a malformed fetch request"; return 1; }
      aws_ s3 cp --only-show-errors "s3://$MA_BACKUP_BUCKET/transfer/$ulid.age" "$DROP/$ulid.age" &&
        chmod 0660 "$DROP/$ulid.age" &&
        aws_ s3 rm --only-show-errors "s3://$MA_BACKUP_BUCKET/transfer/$ulid.age" &&
        log "fetched transfer $ulid" ;;
    manifest-fetch-*)
      # The daily manifest check (ops/manifest.ts): the newest stored manifest, or null if none.
      # Chosen by when S3 stored it, as for a restore (manifest-at.sh), so a name dated in the future
      # cannot pin the check. A failed listing sends no answer: the job retries, it never skips the check.
      ulid=${name#manifest-fetch-}
      [[ "$ulid" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]] || { log "ignored a malformed manifest fetch"; return 1; }
      /usr/local/libexec/memory-anywhere/manifest-at.sh "" "$DROP/.manifest-$ulid.json" >/dev/null &&
        chmod 0660 "$DROP/.manifest-$ulid.json" && mv "$DROP/.manifest-$ulid.json" "$DROP/manifest-$ulid.json" &&
        log "fetched the newest manifest" ;;
    manifest-*.json)
      # Only today's (UTC): the server never writes another date.
      [ "$name" = "manifest-$(date -u +%Y-%m-%d).json" ] || { log "ignored a manifest not dated today"; return 1; }
      aws_ s3 cp --only-show-errors "$f" "s3://$MANIFEST_BUCKET/manifests/$name" &&
        log "stored $name" ;;
    *)
      log "deleted an unknown outbox file (name not logged)" ;;
  esac
}

shopt -s nullglob
for f in "$OUTBOX"/*; do
  name=$(basename "$f")
  # Dot files are writes in progress: the server writes .<name>.tmp and renames it into place.
  case "$name" in .*) continue ;; esac
  # Always remove the file, even on failure: a file left behind would re-trigger the
  # path unit forever. Senders retry (setup-link renews again; alerts recur).
  if ! handle "$f" "$name"; then log "failed to process an outbox file of type ${name%%[-.]*}"; fi
  rm -f "$f"
done
