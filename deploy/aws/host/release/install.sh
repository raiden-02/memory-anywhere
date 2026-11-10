#!/bin/bash
# host/install.sh <release dir>: run as root by ma-updater after the release's
# signature and SHA-256 verified (deployment-aws.md §4, §7.3). Idempotent: every
# step checks what is already there. It never starts the server; the updater does.
set -euo pipefail
umask 022

REL=${1:?usage: install.sh <release dir>}
HOSTDIR="$REL/host"
# shellcheck source=/dev/null
. /etc/memory-anywhere/stack.env
# shellcheck source=/dev/null
. /etc/memory-anywhere/pins.env

log() { echo "install.sh: $*"; }

fetch_verified() { # fetch_verified <url> <algo:sha256|sha512> <hash> <out>
  curl -fsSL --proto '=https' --retry 5 -o "$4" "$1"
  echo "$3  $4" | "$2sum" -c --quiet -
}

# ---- 1. users and groups (§4 step 1, step 7) ----
ensure_group() { getent group "$1" >/dev/null || groupadd --system "$1"; }
ensure_user() { # ensure_user <name> <home>
  id -u "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --no-create-home --shell /sbin/nologin --user-group "$1"
}
ensure_user memory-anywhere /var/lib/memory-anywhere
ensure_user litestream /var/lib/litestream
ensure_user ma-aws /var/lib/ma-aws
ensure_user caddy /var/lib/caddy
ensure_group ma-data # members: memory-anywhere, litestream only
usermod -a -G ma-data memory-anywhere
usermod -a -G ma-data litestream

# ---- 2. pinned binaries (§4 step 2) ----
work=$(mktemp -d /var/tmp/ma-install.XXXXXX)
trap 'rm -rf "$work"' EXIT

if [ "$(cat /opt/memory-anywhere/node/VERSION 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  log "installing Node $NODE_VERSION"
  fetch_verified "$NODE_URL" sha256 "$NODE_SHA256" "$work/node.tar.xz"
  dest="/opt/memory-anywhere/node-$NODE_VERSION"
  rm -rf "$dest" && install -d "$dest"
  tar -xJf "$work/node.tar.xz" -C "$dest" --strip-components=1 --no-same-owner
  echo "$NODE_VERSION" >"$dest/VERSION"
  ln -sfn "$dest" /opt/memory-anywhere/node
fi

if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  log "installing Caddy $CADDY_VERSION"
  fetch_verified "$CADDY_URL" sha512 "$CADDY_SHA512" "$work/caddy.tar.gz"
  tar -xzf "$work/caddy.tar.gz" -C "$work" caddy
  install -m 0755 "$work/caddy" /usr/local/bin/caddy
fi

if ! /usr/local/bin/litestream version 2>/dev/null | grep -q "$LITESTREAM_VERSION"; then
  log "installing Litestream $LITESTREAM_VERSION"
  fetch_verified "$LITESTREAM_URL" sha256 "$LITESTREAM_SHA256" "$work/litestream.tar.gz"
  tar -xzf "$work/litestream.tar.gz" -C "$work" litestream
  install -m 0755 "$work/litestream" /usr/local/bin/litestream
fi

# ---- 3. IMDS firewall (§4 step 3): the server and Caddy users cannot reach IMDS ----
if ! command -v nft >/dev/null; then dnf install -y -q nftables; fi
install -d -m 0755 /etc/nftables
# Numeric UIDs: the users exist by now, and a set of numbers needs no name quoting.
cat >/etc/nftables/memory-anywhere.nft <<EOF
# memory-anywhere and caddy cannot reach IMDS (auth-and-security.md §9).
table inet memory_anywhere {
  chain output {
    type filter hook output priority 0; policy accept;
    ip daddr 169.254.169.254 meta skuid { $(id -u memory-anywhere), $(id -u caddy) } reject
  }
}
EOF
conf=/etc/sysconfig/nftables.conf
touch "$conf"
grep -q 'include "/etc/nftables/memory-anywhere.nft"' "$conf" || echo 'include "/etc/nftables/memory-anywhere.nft"' >>"$conf"
nft list table inet memory_anywhere >/dev/null 2>&1 && nft delete table inet memory_anywhere
nft -f /etc/nftables/memory-anywhere.nft
systemctl enable --quiet nftables.service

# ---- 4. directories (§4 step 7) ----
# setgid: files the server creates (store.db, WAL) belong to ma-data, so Litestream can use them.
install -d -m 2770 -o memory-anywhere -g ma-data /var/lib/memory-anywhere
install -d -m 2770 -o memory-anywhere -g ma-data /var/lib/memory-anywhere/maint
install -d -m 0755 /etc/memory-anywhere /usr/local/libexec/memory-anywhere
install -m 0644 "$HOSTDIR/tmpfiles.conf" /etc/tmpfiles.d/memory-anywhere.conf
systemd-tmpfiles --create /etc/tmpfiles.d/memory-anywhere.conf

# ---- 5. configuration ----
case "$MA_STAGE" in
  prod) site=$MA_HOST ;;
  spike) site="spike.$MA_HOST" ;;
  *) site="eval.$MA_HOST" ;;
esac
cat >/etc/memory-anywhere/server.toml <<EOF
# Written by host/install.sh from /etc/memory-anywhere/stack.env.
[server]
public_origin = "https://$site"
socket = "/run/memory-anywhere/http.sock"
data_dir = "/var/lib/memory-anywhere"

[deployment]
doh_url = "https://cloudflare-dns.com/dns-query"
EOF
chmod 0644 /etc/memory-anywhere/server.toml

install -d -m 0755 /etc/caddy
{
  cat <<EOF
{
	admin off
	email $MA_ALERT_EMAIL
	# Port 80 stays closed: no HTTP redirect listener and no HTTP-01 challenge;
	# Let's Encrypt is the only issuer, matching the CAA record (§4 step 4, §6.2).
	auto_https disable_redirects
	cert_issuer acme {
		disable_http_challenge
	}
}
EOF
  site_block() { # site_block <name> <origin label>
    cat <<EOF

$1 {
	reverse_proxy unix//run/memory-anywhere/http.sock {
		header_up X-Forwarded-For {remote_host}
		header_up X-MA-Origin $2
	}
}
EOF
  }
  case "$MA_STAGE" in
    spike) site_block "spike.$MA_HOST" mcp ;; # the spike serves everything on one name (§9)
    prod) site_block "$MA_HOST" mcp && site_block "admin.$MA_HOST" admin ;;
    *) site_block "eval.$MA_HOST" mcp && site_block "admin.eval.$MA_HOST" admin ;;
  esac
} >/etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

cat >/etc/litestream.yml <<EOF
# deployment-aws.md §5.1 (v0.5 layout). No keys: the SDK uses the instance role.
snapshot:
  interval: 24h
  retention: 168h

dbs:
  - path: /var/lib/memory-anywhere/store.db
    replica:
      type: s3
      bucket: $MA_BACKUP_BUCKET
      path: litestream/store
      region: $MA_REGION
      sse-kms-key-id: $MA_KEY_ARN
      sync-interval: 1s
    meta-path: /run/litestream/store
EOF
chmod 0644 /etc/litestream.yml

# ---- 6. helpers and units (§4 step 5) ----
install -m 0755 "$HOSTDIR/libexec/secrets.sh" /usr/local/libexec/memory-anywhere/secrets.sh
install -m 0755 "$HOSTDIR/libexec/outbox.sh" /usr/local/libexec/memory-anywhere/outbox.sh
for unit in "$HOSTDIR"/units/*; do install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"; done
chmod 0755 "$REL/bin/memory-anywhere-server"
systemctl daemon-reload
systemctl enable --quiet memory-anywhere-secrets.service memory-anywhere.service memory-anywhere-outbox.path caddy.service litestream.service
systemctl start memory-anywhere-outbox.path
systemctl restart caddy.service
log "host configured for $MA_STAGE ($site)"
