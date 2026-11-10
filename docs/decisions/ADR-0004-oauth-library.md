# 0004 OAuth library: node-oidc-provider with opaque tokens; Better Auth as fallback

Status: accepted (M0 Q15: node-oidc-provider 9.13.3 passes all 20 conformance tests with 253 adapter lines)
Date: 2026-11-07

## Context
The MCP TypeScript SDK v2 no longer ships an authorization server. v2 listed Better Auth and node-oidc-provider. Fact-check: Better Auth's MCP plugin issues JWT access tokens, has no recovery codes, and documents no refresh-family revocation; its user table expects an email (review2-factcheck row 20, C0.1). An aggregator lists many 2026 Better Auth CVEs (review2-security O9, unverified). node-oidc-provider 9.13 supports RFC 7591, 8707, 9207 and DPoP; CIMD is experimental (row 21).

## Decision
Default to node-oidc-provider pinned `~9.13`, opaque access tokens stored hashed, CIMD and registration gated by our pairing hook, every non-required grant and route disabled. Passkeys via @simplewebauthn/server; owner, recovery codes, consent, pairing and step-up are our code. M0 spikes node-oidc-provider only. If M0 Q15 shows it cannot pass the conformance list (m0-spike.md §5), use Better Auth with JWT access tokens audience-bound to the MCP URL, ≤ 1 h, `refreshTokenReuseInterval: 0`, and a server-side revocation check; its user table's required email is filled with the synthetic `owner@memory-anywhere.invalid`.

## Consequences
The host application routes both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` to the provider mounted at `/oauth`, and `routes.allow.txt` starts with the provider's mandatory routes (auth-and-security.md §4.7).
More adapter code than Better Auth, fewer default routes to audit. The experimental CIMD feature can break in minor versions, hence `~` pinning and the conformance suite in CI.

## Update 2026-11-08: M0 Q15 result

Question: Q15.

### Method
- `spikes/oauth-oidc-provider`: oidc-provider 9.13.3 (`~9.13.3`), @simplewebauthn/server 14.1.0, MCP SDK v2 (@modelcontextprotocol/server 2.4.0, @modelcontextprotocol/node 2.1.2), node:sqlite on Node 24.22.2. The provider is mounted at `/oauth`. The host app routes both discovery paths to it and runs the pairing gates as provider middleware (`provider.use`), so the library handles each request itself, unchanged.
- `packages/server/test/oauth-conformance/`: the 20 tests of m0-spike.md §5 against a local issuer, started per run in a data directory whose path has a space. A software WebAuthn authenticator (ES256, `none` attestation, user verification) lets consent and setup run the real passkey code. CIMD fetches go through the library's own transport with its SSRF dispatcher in place; the test replaces only the network.
- The read-only subset (1–3, 5, 6, 15–18) also ran against the deployed spike: `https://spike.{host}` behind Caddy, release 0.0.1-m0.5.
- Adapter size: `node spikes/oauth-oidc-provider/count-adapter.ts`. Advisory history: the GitHub Advisory Database (GraphQL `securityVulnerabilities` and REST `/advisories`), with a control query.

### Result
- **Local: 24/24.** These are the 20 tests, with test 8 split into four vendor cases and an extra `fixed`-rotation case for test 11: [`conformance-local.txt`](../results/evidence/ADR-0004/conformance-local.txt).
- **Spike: 8/8 read-only tests.** These include the route inventory through Caddy, and `issuer = https://spike.{host}`, which shows X-Forwarded-Proto is honoured: [`conformance-spike.txt`](../results/evidence/ADR-0004/conformance-spike.txt).
- **Test 6 timings:**
  - Locally, from a cold process: discovery 1 ms, registration 3 ms, token 2 ms, refresh 2 ms.
  - On the spike, from the PC: 44 ms each.
- **Adapter: 253 lines** (limit 400). Provider configuration 105, SQLite adapter 45, gates and mount 94, provider route table 9.
  - The whole spike is 1,055 lines. The rest (pairing, passkeys, consent, pages, MRTR state) is memory-anywhere code with either library: [`adapter-lines.txt`](../results/evidence/ADR-0004/adapter-lines.txt).
- **Advisories** ([`ghsa-advisories.txt`](../results/evidence/ADR-0004/ghsa-advisories.txt)):
  - `oidc-provider`: **0** ever published. Control: the same query returns 77 for `next`.
  - `better-auth`: 30. Among them are 2026 advisories for refresh-token replay, concurrent code redemption and plain PKCE accepted by default, in exactly the plugins the fallback would use.
  - `@simplewebauthn/server`: 1 low (≤ 13.3.1, attestation trust chains). It does not affect 14.1.0, and we use `none` attestation anyway.
- What the library needed from us (each item covered by a test):
  1. **Extra routes.** The library registers routes its feature flags do not suggest:
     - `POST /session/end/confirm`, with logout disabled;
     - `GET /reg/:id`, without RFC 7592;
     - PAR and DPoP, both enabled by default.

     A host-side allow-list of provider routes answers 404 for everything else, and PAR and DPoP are disabled explicitly. Test 15 found all four.
  2. **Fresh grants.** If `loadExistingGrant` returns nothing, the library also discards the grant the owner just approved. It now returns only the grant of the current interaction, so consent is still never remembered.
  3. **Errors.**
     - After the library has run, any failure on `/reg` or `/auth` is replaced with one response: one JSON body for `/reg`, one HTML page for `/auth`, never a redirect.
     - Before it runs, `request`, `request_uri` and any `response_mode` other than `query` are refused.
  4. **Refresh grace (30 s, §5.3).** A host-side cache of the rotation response, kept in memory only because it holds live tokens. After 30 s the library's own reuse detection revokes the grant (test 11).
  5. **Static vendor clients.** Created through the library's Client adapter. For them, `client_secret_post` is rewritten to Basic.
  6. **Passkey challenges.** @simplewebauthn base64url-encodes a string challenge, so the server passes raw bytes.
- **Not yet run:** the vendor flows (ChatGPT, Claude, Gemini, Grok) on the spike. They are recorded in ADR-0101, 0103, 0107 and 0108. A failure there caused by the library reopens this ADR.

### Decision
node-oidc-provider `~9.13.3` is the authorization server; Better Auth is not spiked. auth-and-security.md §4.7 changes:
- The provider's interactions live at `/consent/*` (host routes, §2), and its resume route is `/oauth/auth/:uid`, so there is no `/oauth/interaction/*`.
- `routes.allow.txt` lists exactly the routes that answer.

spec-issues.md #16–#18 record the other gaps.

### Consequences
- The conformance suite (`packages/server/test/oauth-conformance`) is the M2 gate. `issuer.ts` is the one place that starts the server, so M2 points it at the product and keeps the tests.
- Upgrading within `~9.13` must re-run the suite: the route allow-list and the error normalisation depend on the library's route names and events.
- In the spike, the admin and setup pages are on the spike origin; the product serves them on `admin.{host}` (§2).
