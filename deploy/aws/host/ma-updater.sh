#!/bin/bash
# memory-anywhere updater (deployment-aws.md §7.3), installed by user data as
# /usr/local/sbin/ma-updater and run as root by ma-updater.timer every 2 minutes.
#
# A release is s3://$MA_RELEASES_BUCKET/releases/<version>.tar.gz plus
# <version>.tar.gz.minisig; <prefix>/release/desired holds {"version","sha256"}.
# The tarball contains:
#   VERSION                          the version string, nothing else
#   bin/memory-anywhere-server       backup --out <file> | migrate | start ...
#   host/install.sh <release dir>    root, idempotent: system packages, users, units, configs
# Nothing in a release runs before its SHA-256 and a trusted minisign signature
# (/etc/memory-anywhere/release-keys/*.pub, written by user data) both verify.
set -euo pipefail
umask 022

# shellcheck source=/dev/null
. /etc/memory-anywhere/stack.env

STATE=/var/lib/memory-anywhere-updater
RELEASES=/opt/memory-anywhere/releases
CURRENT=/opt/memory-anywhere/current
DATA=/var/lib/memory-anywhere
SOCKET=/run/memory-anywhere/http.sock
KEYS=/etc/memory-anywhere/release-keys
LOCK=/run/ma-updater.lock

log() { echo "ma-updater: $*"; }

aws_() { aws --region "$MA_REGION" "$@"; }

alert() { # alert <id> <message>; subject and short text only, never content
  aws_ sns publish --topic-arn "$MA_TOPIC_ARN" --subject "memory-anywhere $MA_STAGE: $1" --message "$2" >/dev/null || log "could not publish alert $1"
}

json_field() { # json_field <field>  (reads JSON on stdin)
  python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print("" if v is None else v)' "$1"
}

health_ok() { # health_ok <version>: /v1/health over the socket reports that version
  local body
  body=$(curl -fsS --max-time 5 --unix-socket "$SOCKET" http://localhost/v1/health 2>/dev/null) || return 1
  [ "$(printf '%s' "$body" | json_field version)" = "$1" ]
}

wait_healthy() { # wait_healthy <version>: up to 60 s
  local i
  for i in $(seq 1 30); do
    if health_ok "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

switch_current() { # switch_current <release dir>: atomic symlink swap
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

install_release() { # install_release <version> <sha256>
  local version=$1 sha=$2 work dest previous="" verified=""
  work=$(mktemp -d /var/tmp/ma-release.XXXXXX)
  # shellcheck disable=SC2064 # expand $work now: it is local to this function
  trap "rm -rf '$work'" RETURN

  aws_ s3 cp --only-show-errors "s3://$MA_RELEASES_BUCKET/releases/$version.tar.gz" "$work/release.tar.gz"
  aws_ s3 cp --only-show-errors "s3://$MA_RELEASES_BUCKET/releases/$version.tar.gz.minisig" "$work/release.tar.gz.minisig"
  if ! echo "$sha  $work/release.tar.gz" | sha256sum -c --quiet - >/dev/null 2>&1; then
    log "refusing $version: SHA-256 does not match release/desired"
    alert update_failed "Release $version refused: SHA-256 mismatch."
    return 1
  fi
  for key in "$KEYS"/*.pub; do
    if /usr/local/bin/minisign -V -q -p "$key" -m "$work/release.tar.gz" -x "$work/release.tar.gz.minisig"; then
      verified=$(basename "$key")
      break
    fi
  done
  if [ -z "$verified" ]; then
    log "refusing $version: no trusted key verifies the signature"
    alert update_failed "Release $version refused: signature not from a key this stage trusts."
    return 1
  fi
  log "release $version verified with $verified"

  if [ -L "$CURRENT" ]; then previous=$(readlink -f "$CURRENT"); fi
  if [ -n "$previous" ] && [ -f "$DATA/store.db" ]; then
    runuser -u memory-anywhere -- "$CURRENT/bin/memory-anywhere-server" backup --out "$DATA/pre-$version.db"
  fi

  dest="$RELEASES/$version"
  rm -rf "$dest"
  install -d -m 0755 "$dest"
  tar -xzf "$work/release.tar.gz" -C "$dest" --no-same-owner --no-same-permissions
  if [ "$(tr -d '[:space:]' <"$dest/VERSION")" != "$version" ]; then
    log "refusing $version: VERSION file says $(cat "$dest/VERSION")"
    rm -rf "$dest"
    return 1
  fi
  bash "$dest/host/install.sh" "$dest"

  systemctl stop memory-anywhere.service 2>/dev/null || true
  if [ -f "$DATA/store.db" ]; then
    runuser -u memory-anywhere -- "$dest/bin/memory-anywhere-server" migrate
  fi
  switch_current "$dest"
  systemctl start memory-anywhere.service

  if wait_healthy "$version"; then
    log "release $version healthy"
    date -u +%s >"$STATE/healthy-since"
    return 0
  fi

  log "release $version failed its health check; rolling back"
  systemctl stop memory-anywhere.service || true
  if [ -n "$previous" ]; then
    if [ -f "$DATA/pre-$version.db" ]; then
      install -m 0660 -o memory-anywhere -g ma-data "$DATA/pre-$version.db" "$DATA/store.db"
    fi
    switch_current "$previous"
    systemctl start memory-anywhere.service || true
  fi
  rm -f "$STATE/healthy-since"
  alert update_failed "Release $version failed its health check and was rolled back."
  return 1
}

dns_check() { # hourly: {host} names resolve (DoH, port 443) to this instance's public IP
  local stamp="$STATE/dns-checked" now names doh token ip name got
  now=$(date -u +%s)
  if [ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt 3600 ]; then return 0; fi
  echo "$now" >"$stamp"
  case "$MA_STAGE" in
    prod) names="$MA_HOST admin.$MA_HOST" ;;
    spike) names="spike.$MA_HOST" ;;
    *) names="eval.$MA_HOST admin.eval.$MA_HOST" ;;
  esac
  doh=https://cloudflare-dns.com/dns-query
  if [ -f /etc/memory-anywhere/server.toml ]; then
    doh=$(sed -n 's/^[[:space:]]*doh_url[[:space:]]*=[[:space:]]*"\(https:[^"]*\)".*/\1/p' /etc/memory-anywhere/server.toml | head -n1)
    doh=${doh:-https://cloudflare-dns.com/dns-query}
  fi
  token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
  ip=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4)
  for name in $names; do
    got=$(curl -fsS --max-time 10 -H 'accept: application/dns-json' "$doh?name=$name&type=A" |
      python3 -c 'import json,sys; print(" ".join(sorted(a["data"] for a in json.load(sys.stdin).get("Answer",[]) if a.get("type")==1)))') || got="(lookup failed)"
    if [ "$got" != "$ip" ]; then
      log "dns_mismatch: $name resolves to '$got', expected $ip"
      alert dns_mismatch "$name resolves to '$got', not this instance's Elastic IP $ip."
    fi
  done
}

acme_account() { # store Caddy's ACME account URI once it exists (§4 step 6)
  local stamp="$STATE/acme-account-uri" file uri
  file=$(find /var/lib/caddy -path '*acme-v02.api.letsencrypt.org-directory/users/*' -name '*.json' 2>/dev/null | head -n1)
  [ -n "$file" ] || return 0
  uri=$(json_field location <"$file") || return 0
  [ -n "$uri" ] || return 0
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$uri" ]; then
    aws_ ssm put-parameter --name "$MA_PREFIX/acme/account-uri" --type String --overwrite --value "$uri" >/dev/null
    echo "$uri" >"$stamp"
    log "stored ACME account URI"
  fi
}

housekeeping() { # §7.3 step 8
  local since now keep
  if [ -f "$STATE/healthy-since" ]; then
    since=$(cat "$STATE/healthy-since")
    now=$(date -u +%s)
    if [ $((now - since)) -ge 86400 ]; then
      find "$DATA" -maxdepth 1 -type f \( -name 'pre-*.db' -o -name 'pre-migrate-*.db' -o -name 'pre-restore-*.db' \) -mmin +1440 \
        -exec shred -n0 -z -u {} +
    fi
  fi
  # Keep the current release and the two before it.
  keep=$(readlink -f "$CURRENT" 2>/dev/null || true)
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{print $2}' | tail -n +4 |
    while read -r dir; do
      if [ "$dir" != "$keep" ]; then rm -rf "$dir"; fi
    done
}

main() {
  exec 9>"$LOCK"
  flock -n 9 || { log "another run is in progress"; exit 0; }
  install -d -m 0700 "$STATE"

  local desired version sha current=""
  if ! desired=$(aws_ ssm get-parameter --name "$MA_PREFIX/release/desired" --query Parameter.Value --output text 2>/dev/null); then
    log "no release/desired yet"
    exit 0
  fi
  version=$(printf '%s' "$desired" | json_field version)
  sha=$(printf '%s' "$desired" | json_field sha256)
  if ! [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$ ]] || ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    log "release/desired is malformed; ignoring"
    exit 1
  fi
  if [ -f "$CURRENT/VERSION" ]; then current=$(tr -d '[:space:]' <"$CURRENT/VERSION"); fi

  if [ "$version" != "$current" ]; then
    install_release "$version" "$sha" || true
  elif ! health_ok "$version"; then
    rm -f "$STATE/healthy-since"
  elif [ ! -f "$STATE/healthy-since" ]; then
    date -u +%s >"$STATE/healthy-since"
  fi

  dns_check || log "dns check failed to run"
  acme_account || log "acme account step failed"
  housekeeping
}

main "$@"
