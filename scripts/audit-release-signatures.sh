#!/bin/bash
# scripts/audit-release-signatures.sh <tarball>: `npm audit signatures` over exactly the
# dependencies a server release ships (auth-and-security.md §10): every package in its
# node_modules must carry a valid npm registry signature. The workspace package
# @memory-anywhere/contracts is not from the registry, so the audit runs on a copy without it.
set -euo pipefail

TARBALL=${1:?usage: audit-release-signatures.sh <tarball>}
work=$(mktemp -d "${TMPDIR:-/tmp}/ma release audit.XXXXXX")
trap 'rm -rf "$work"' EXIT

tar -xzf "$TARBALL" -C "$work" --no-same-owner app/node_modules app/packages/server/package.json
app="$work/app"
rm -f "$app/node_modules/@memory-anywhere/contracts"
# npm reads the tree from node_modules; the root manifest lists the server's registry dependencies.
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1] + "/packages/server/package.json", "utf8"));
const deps = Object.fromEntries(Object.entries(pkg.dependencies).filter(([n]) => !n.startsWith("@memory-anywhere/")));
fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: "memory-anywhere-server-release", private: true, dependencies: deps }, null, 2));
' "$app"
(cd "$app" && npm audit signatures)
