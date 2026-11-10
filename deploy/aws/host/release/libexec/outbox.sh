#!/bin/bash
# memory-anywhere-outbox.service (user ma-aws): act on each file the server wrote
# to /run/memory-anywhere/outbox, by name prefix, then delete it (deployment-aws.md §4).
# The server never holds AWS credentials; this fixed script is its only way out.
set -uo pipefail
umask 007
OUTBOX=/run/memory-anywhere/outbox
DROP=/run/memory-anywhere/inbox/drop
aws_() { aws --region "$MA_REGION" "$@"; }
log() { echo "outbox: $*"; }

# handle <file> <name>: returns non-zero if any step fails. Steps are chained with
# && because `set -e` does not apply inside a function called as a condition.
handle() {
  local f=$1 name=$2 id ulid json
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
