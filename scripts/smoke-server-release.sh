#!/bin/bash
# scripts/smoke-server-release.sh <tarball> <version>: unpacks a server release the way the
# updater does (deployment-aws.md §7.3) and checks that it runs on this machine: the launcher,
# the contracts link, a store created by `migrate`, and both native modules. Run by CI on
# linux-arm64 after build-server-release.ts; needs node 24 on PATH.
set -euo pipefail

TARBALL=${1:?usage: smoke-server-release.sh <tarball> <version>}
VERSION=${2:?usage: smoke-server-release.sh <tarball> <version>}
work=$(mktemp -d "${TMPDIR:-/tmp}/ma release smoke.XXXXXX") # a space, as on every runner
trap 'rm -rf "$work"' EXIT

rel="$work/release"
mkdir -p "$rel"
tar -xzf "$TARBALL" -C "$rel" --no-same-owner
fail() { echo "smoke: $*" >&2; exit 1; }

[ "$(tr -d '[:space:]' <"$rel/VERSION")" = "$VERSION" ] || fail "VERSION is not $VERSION"
[ -L "$rel/app/node_modules/@memory-anywhere/contracts" ] || fail "contracts is not a symlink (Node would refuse its .ts files)"
[ -x "$rel/bin/memory-anywhere-server" ] || fail "the launcher is not executable"
for f in install.sh first-store.sh libexec/outbox.sh libexec/ma-maint.sh libexec/secrets.sh units/memory-anywhere.service units/ma-maint.service; do
  [ -f "$rel/host/$f" ] || fail "host/$f is missing"
done

out=$("$rel/bin/memory-anywhere-server" version)
case "$out" in *"\"server\":\"$VERSION\""*) ;; *) fail "version printed $out" ;; esac

# A store from nothing: migrations (SQL and data steps), seed files and the contracts package.
mkdir -p "$work/data"
cat >"$work/server.toml" <<EOF
[server]
mode = "local"
data_dir = "$work/data"
models_dir = "$work/models"
EOF
"$rel/bin/memory-anywhere-server" migrate --config "$work/server.toml" >/dev/null
[ -s "$work/data/store.db" ] || fail "migrate created no store"

# The natives load from the release's own node_modules. ($argon2id$ is a hash prefix, not a variable.)
# shellcheck disable=SC2016
(cd "$rel/app" && node --input-type=module -e '
const argon2 = await import("argon2");
if (!(await argon2.hash("smoke")).startsWith("$argon2id$")) throw new Error("argon2");
const ort = await import("onnxruntime-node");
if (typeof ort.InferenceSession?.create !== "function") throw new Error("onnxruntime-node");
')
echo "smoke: release $VERSION runs"
