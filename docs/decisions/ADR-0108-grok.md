# 0108 Grok custom connectors

Status: accepted (DCR inside the pairing window)
Date: 2026-11-09
Milestone: M0
Question: Q11

## Context
Grok (grok.com) offers custom connectors. Q11 asks:
- which auth methods work, in the order static OAuth credentials, CIMD, DCR, static bearer;
- how writes are approved;
- whether Grok mobile has connectors;
- whether server instructions pass;
- whether xAI's API supports function calling, for the eval harness.

If no method works with a public server and auth, Grok is unsupported in v1.

## Options
In the order tried: static OAuth credentials, CIMD, DCR (inside the pairing window), static bearer header.

## Method
- **Where:** grok.com on Windows (Chrome), SuperGrok. The steps were driven by Claude Code in the owner's Chrome. The owner
  filled Grok's age form, approved the passkey prompts and clicked Approve in Grok's popup.
- **Setup:** connectors → New Connector → Custom.
- **Server:** spike releases 0.0.1-m0.12 to m0.16.

## Result
Evidence: [`docs/results/evidence/ADR-0108/grok-web.md`](../results/evidence/ADR-0108/grok-web.md).
- **The dialog has only Name and Server URL.** Static OAuth credentials, CIMD and a bearer header cannot be entered. Grok
  discovers the server through the protected-resource document and the **OIDC** path, then registers with **DCR**:
  - `client_name: "Grok"`;
  - redirect `https://grok.com/connectors-oauth-exchange-code/`;
  - `token_endpoint_auth_method: none`;
  - grants `authorization_code` and `refresh_token`;
  - **no `application_type`**.

  It then authorizes in a popup with PKCE.
- **Grok asks for every advertised scope** (`memory.read memory.write memory.capture`).
- **Two issuer fixes were needed before Grok connected** (ADR-0004, negative-results.md):
  - default `application_type` to `web` (spec-issues #19);
  - client-dependent resource scopes, so `memory.capture` is dropped for vendors instead of reopening consent.
- **Grok works unprompted and without approval.** "What is my test planet?" → "Neptune…", and "Remember that my test mountain is
  Everest." → saved. No approval was asked and no custom instruction was set. Grok finds tools by search
  (`search_connected_tools`) and opens a new MCP session before each call.
- **Instructions:** server instructions do not pass (0/3, ADR-0104).
- **xAI API:** supports function calling ("Define custom tools that the model can invoke", docs.x.ai). Remote MCP is not mentioned.
- **Mobile:** see *Mobile* below.

### Mobile
Pending the owner's phone check ("What is my test planet?" in the Grok app). Recorded here when done.

## Decision
- **DCR inside the pairing window** is Grok's method: the only one its dialog allows. `config/vendors.json` (`grok`) records:
  - the method `dcr`;
  - the exact redirect;
  - `token_endpoint_auth_method: none`;
  - the missing `application_type`.
- **The registration gate** accepts Grok's request only while a Grok window is open.
- **Writes are not approved by Grok.** Grok is a normal (not T1) client; its saves follow the review rules for clients without
  elicitation (ADR-0106).
- **Eval harness:** a Grok harness through xAI's API is possible with function declarations, but needs an xAI key. No eval key
  exists, so Grok eval rows stay manual (as ADR-0111 records for Gemini).

## Consequences
- **Grok is supported in v1**, with automatic save and recall, the strongest of the chat apps.
- **Grok's popup flow is our only DCR client.** The DCR path, the window gate and the `application_type` default must stay
  covered by conformance tests 8a–8g.
