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
