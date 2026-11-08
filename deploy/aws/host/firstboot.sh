#!/bin/bash
# First boot (deployment-aws.md §4), installed by user data as /usr/local/sbin/ma-firstboot.
# Idempotent. It prepares only what the updater needs to verify a release:
# swap, minisign (pinned hash) and the updater timer. The updater then installs
# the first signed release, whose host/install.sh sets up everything else.
set -euo pipefail
exec >>/var/log/ma-firstboot.log 2>&1
echo "== ma-firstboot $(date -u +%FT%TZ)"

# Both files are written by user data (lib/user-data.ts); pins.env is host/pins.env.
# shellcheck source=/dev/null
. /etc/memory-anywhere/stack.env
# shellcheck source=/dev/null
. /etc/memory-anywhere/pins.env

# 1 GiB swap file (§2). The server and Litestream units set MemorySwapMax=0.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# minisign from the pinned release archive, checked against pins.env.
if ! /usr/local/bin/minisign -v 2>/dev/null | grep -q "$MINISIGN_VERSION"; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSL --proto '=https' --retry 5 -o "$work/minisign.tar.gz" "$MINISIGN_URL"
  echo "$MINISIGN_SHA256  $work/minisign.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$work/minisign.tar.gz" -C "$work" minisign-linux/aarch64/minisign
  install -m 0755 "$work/minisign-linux/aarch64/minisign" /usr/local/bin/minisign
fi

install -d -m 0755 /opt/memory-anywhere/releases /var/lib/memory-anywhere-updater
systemctl daemon-reload
systemctl enable --now ma-updater.timer
# First run now rather than in two minutes; the release may not be uploaded yet,
# in which case the updater exits quietly and the timer retries.
systemctl start --no-block ma-updater.service
echo "== ma-firstboot done"
