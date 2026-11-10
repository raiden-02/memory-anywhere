# 0107 Gemini custom MCP app

Status: accepted (static credentials, refresh rotation on)
Date: 2026-11-09
Milestone: M0
Question: Q10

## Context
Gemini (gemini.google.com) can connect a custom MCP server in Developer Mode. Q10 asks:
- whether manually entered static client credentials work, and with which token auth method;
- what the exact redirect URI is;
- whether Gemini tolerates refresh-token rotation;
- whether it needs DCR.

## Options
1. Static confidential client, with rotation on, or `fixed` if rotation fails.
2. DCR inside the pairing window, with the recorded redirect.

## Method
- **Where:** gemini.google.com on Windows (Chrome), Google AI Pro. The steps were driven by Claude Code in the owner's Chrome. The
  owner approved the passkey prompts and asked Claude Code to accept Google's risk acknowledgement.
- **Server:** spike releases 0.0.1-m0.6 to m0.16.
- **Setup:** Settings → Developer Mode → Create new → Connect to an MCP server, with the window's client id and secret.
- **Chats:** in Developer Mode, with Flash and 3.1 Pro.
- **Refresh:** the access-token lifetime is 1 h, with `client_policy` rotation on. A refresh was forced by using the app after the
  token expired, and again after the rotated refresh token's access token expired.

## Result
Evidence: [`docs/results/evidence/ADR-0107/gemini-web.md`](../results/evidence/ADR-0107/gemini-web.md).
- **Static credentials work.** Gemini uses `client_secret_basic` (`POST /oauth/token 200`, ua `OpenAuth`).
- **The redirect is per user and per server:**
  `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<Google user id>-<server host, dots as underscores>`.
  The dialog shows it ("Copy redirect URI").
- **Discovery** uses the protected-resource document and then the **OIDC** path `/.well-known/openid-configuration`.
- **Rotation works twice in a row.** Both refreshes returned 200: 18:27 with the original token, 00:20 the next day with the
  rotated one.
- **The app must be saved.** Navigating away before "Save your custom app" → Connect leaves it unsaved, although the grant exists.
- **Models:**
  - Only **3.1 Pro** calls the tools. Flash never did, before or after the schema changes.
  - Every tool call shows an approval card (Don't allow · Allow once · Always allow).
  - "Remember…" with Gemini's instruction set did not save (ADR-0104).

## Decision
- **Static confidential client**, `client_secret_basic`, refresh rotation **on**. DCR is not needed.
- **Pairing window:** the redirect cannot be preset, because it contains the owner's Google user id. The spike accepted
  any redirect on Google's redirect host. M1 tightens this: the window's Gemini client accepts a redirect only if it meets two
  conditions:
  - it starts with `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-`;
  - it ends with `-<this server's host, dots as underscores>`.

  The owner pastes nothing. `config/vendors.json` records the prefix and the host-encoding rule.
- **Not run:** the rotation-off run, because rotation passed and `fixed` is only the fallback.

## Consequences
- **Gemini saves only on request.** It works for recall and for explicit saves with Pro. Flash and unprompted saves do not work, so
  eval suite X records Gemini as Pro-only and explicit-save-only. Re-test when Google changes Developer Mode or Flash.
- **A Gemini-safe schema subset.** Tool schemas stay within the JSON Schema subset Gemini accepts: no `$schema`, and no empty
  `properties` (kept from the Flash investigation).
- **Gemini is web-only.** Developer Mode is a web feature, so Gemini on the phone is not tested in M0 and is not claimed.
