# 0102 ChatGPT client registration

Status: accepted (static credentials)
Date: 2026-11-09
Milestone: M0
Question: Q03

## Context
auth-and-security.md prefers static confidential clients created inside a pairing window, with CIMD and then DCR as fallbacks.
Q03 asks which method ChatGPT supports for a custom MCP server and what its exact redirect URI and CIMD URL are.

## Options
In the order tried: static credentials (User-Defined OAuth Client), CIMD, DCR. Each one inside a pairing window.

## Method
- **Where:** chatgpt.com on Windows (Chrome), ChatGPT Plus. The steps were driven by Claude Code in the owner's Chrome, and the
  owner approved the passkey prompts.
- **Server:** spike releases 0.0.1-m0.5 and m0.6.
- **Dialog:** Plugins → Add → "Add custom MCP server". Registration method User-Defined OAuth Client, with the window's client id
  and secret and `client_secret_basic`.

## Result
Evidence: [`docs/results/evidence/ADR-0102/chatgpt-web-registration.md`](../results/evidence/ADR-0102/chatgpt-web-registration.md).
- **Static credentials work** on the first try:
  `grant_created vendor=chatgpt redirect_uri=https://chatgpt.com/connector_platform_oauth_redirect`.
- **What ChatGPT discovers itself:**
  - The registration methods it offers: User-Defined OAuth Client, DCR, CIMD (the default).
  - CIMD client metadata URL: `https://chatgpt.com/oauth/client.json`.
  - Endpoints: through the OIDC configuration.
  - Scopes ticked: `memory.read memory.write`, **without `offline_access`**.
- **Token auth methods offered:** none, `client_secret_basic`, `client_secret_post`.
- **Failure on the way:** without `offline_access`, oidc-provider bound ChatGPT's tokens to the 10-minute consent session, and the
  connection "expired". Fixed in the issuer (`expiresWithSession: false`, conformance test 11c; ADR-0004, negative-results.md).

## Decision
Static confidential client (the default), redirect `https://chatgpt.com/connector_platform_oauth_redirect`, `client_secret_basic`.
The values go into `config/vendors.json` (`chatgpt`):
- redirect;
- the CIMD URL, for a later fallback;
- the omitted `offline_access`;
- the dialog path.

No spec change beyond what ADR-0004 recorded for the token lifetime.

## Consequences
- **Pairing.** The owner pastes two values into ChatGPT's dialog; `mema` prints them in the pairing window.
- **Refresh tokens.** ChatGPT never asks for `offline_access`. Grants must not depend on it, and conformance test 11c keeps that
  true.
