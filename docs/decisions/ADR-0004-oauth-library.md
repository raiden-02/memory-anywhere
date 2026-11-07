# 0004 OAuth library: node-oidc-provider with opaque tokens; Better Auth as fallback

Status: proposed (accepted or replaced by M0 Q15)
Date: 2026-11-07

## Context
The MCP TypeScript SDK v2 no longer ships an authorization server. v2 listed Better Auth and node-oidc-provider. Fact-check: Better Auth's MCP plugin issues JWT access tokens, has no recovery codes, and documents no refresh-family revocation; its user table expects an email (review2-factcheck row 20, C0.1). An aggregator lists many 2026 Better Auth CVEs (review2-security O9, unverified). node-oidc-provider 9.13 supports RFC 7591, 8707, 9207 and DPoP; CIMD is experimental (row 21).

## Decision
Default to node-oidc-provider pinned `~9.13`, opaque access tokens stored hashed, CIMD and registration gated by our pairing hook, every non-required grant and route disabled. Passkeys via @simplewebauthn/server; owner, recovery codes, consent, pairing and step-up are our code. M0 spikes node-oidc-provider only. If M0 Q15 shows it cannot pass the conformance list (m0-spike.md §5), use Better Auth with JWT access tokens audience-bound to the MCP URL, ≤ 1 h, `refreshTokenReuseInterval: 0`, and a server-side revocation check; its user table's required email is filled with the synthetic `owner@memory-anywhere.invalid`.

## Consequences
The host application routes both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` to the provider mounted at `/oauth`, and `routes.allow.txt` starts with the provider's mandatory routes (auth-and-security.md §4.7).
More adapter code than Better Auth, fewer default routes to audit. The experimental CIMD feature can break in minor versions, hence `~` pinning and the conformance suite in CI.
