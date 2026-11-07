# 0017 Pairing window; no open dynamic client registration

Status: accepted
Date: 2026-11-07 (revised in round 3)

## Context
Vendor redirect URIs are shared by every user of a product, so a redirect allow-list proves the vendor, not the account (review2-security O1, O2, verdict 1). v2 kept DCR open for Gemini; Gemini also accepts manually entered credentials (factcheck row 2).

## Decision
Registration and authorization for a vendor are possible only within 10 minutes of the owner opening "Connect a new app" with a passkey; one registration and one grant per window; one active grant per vendor; fresh passkey on every consent; consent never remembered. Static credentials are the default for Claude, ChatGPT and Gemini (Claude's custom-connector dialog accepts a client id and secret), because a shared vendor CIMD client id can be presented by any user of that vendor; CIMD and DCR are fallbacks inside a window. CIMD stays for Claude Code when it connects directly over HTTP without the plugin. Round 3 also binds the window to the owner's browser (a `__Host-ma_pair` cookie set from the admin UI, or a typed pair code), makes window state unobservable to probes, and closes the window on a registration race. Spec: auth-and-security.md §4.

## Consequences
Connecting an app is a two-device dance the first time (admin UI and vendor app). Re-authorization after a token expiry also needs a window. Accepted; it happens rarely.
