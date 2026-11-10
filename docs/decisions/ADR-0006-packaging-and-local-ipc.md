# 0006 Pure-JS client, loopback-plus-token local mode, no named pipes, no single-file binary in v1

Status: accepted
Date: 2026-11-07

## Context
Node cannot set a DACL on a Windows named pipe; the default DACL gives Everyone read (review2-architecture N21, review2-factcheck row 24, review2-security H7). The security review proposed a native helper with an explicit DACL, mutual process checks, and DPoP-bound tokens with a TPM key (D-15, O6). A single-file binary with native addons is not straightforward (N29, factcheck B12). The owner's PC no longer runs a store (ADR-0001).

## Options
1. Native helper for pipe DACL and TPM-bound DPoP keys on the PC.
2. Pure-JS client; tokens in a user-ACL'd file; local mode on 127.0.0.1 with a random token and Host/Origin checks.

## Decision
Option 2. With the store on AWS, the named pipe is only a local-mode concern, and loopback plus a token gives the same protection against other users. Same-user malware can read any user-space secret, including DPAPI-protected ones, so a TPM key would add native code to every install for little gain; instead the PC grant carries no admin rights and admin actions need passkey step-up (auth-and-security.md §5.6, §6). No Credential Manager binding, no SEA binary in v1; the client ships as an npm package and as a bundled `.mjs` inside each plugin.

## Consequences
The client installs with zero native modules and zero install scripts. A stolen PC token can save T2 memories in enabled repos and recall within budgets until revoked (accepted residual, auth-and-security.md §1.5). M0 Q22 may later remove better-sqlite3 from the server via node:sqlite.

## Update 2026-11-08: M0 Q22, node:sqlite

Question: Q22. Does `node:sqlite` on Node 24 support FTS5, WAL and the PRAGMAs of data-model.md §1?

### Method
`spikes/sqlite-check/src/q22.ts` opens a file database in a directory whose path has a space and checks: FTS5 in the compile options; `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `secure_delete = ON`, `wal_autocheckpoint = 0` (each read back); the `memory_fts` table of data-model.md §2 with `porter unicode61 remove_diacritics 2` (stemming and accent folding by query); column filters and `bm25()` column weights; enforced foreign keys; JSON functions; the purge sequence (delete, FTS `optimize`, `wal_checkpoint(TRUNCATE)`), then a byte scan of the database and WAL files for a canary; `VACUUM INTO` with `integrity_check` on the copy (the `ma-maint` step). The same checks run as a test on every CI runner: Windows x64, Ubuntu x64 and arm64, macOS arm64, Node 24.22.2 and 26.

### Result
All 17 checks pass on the owner's PC (Windows 11, Node v24.22.2, SQLite 3.53.4). Evidence: [`q22-windows-x64.json`](../results/evidence/ADR-0006/q22-windows-x64.json); the CI runs of `spikes/sqlite-check/test/q22.test.ts` cover the other platforms. The purge canary is present before the purge and absent from both files after it.

### Decision
**Accepted.** `node:sqlite` provides everything data-model.md needs, on every supported platform, with no native module. M1 builds the server on `node:sqlite` instead of `better-sqlite3`, which removes one prebuilt native dependency from the server tarball and from `onlyBuiltDependencies` (config-and-cli.md §2 is updated in M1 when the dependency list is pinned). `node:sqlite` is still marked as a release candidate in Node's documentation; if a Node release changes its API, the store's thin database layer absorbs it.
