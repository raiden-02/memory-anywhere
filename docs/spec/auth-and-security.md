# Authentication and security

Status: normative. The full baseline ships with the first public exposure (M2). The M0 spike endpoint holds only throwaway data and is destroyed before M2.

## 1. Threat model

### 1.1 Assets

1. Memory content, including sensitive items and other people's data.
2. OAuth grants, refresh tokens and step-up tokens.
3. The owner's passkeys and recovery codes.
4. The AWS account: instance, backups, KMS key, DNS.
5. The integrity of the profile and session-start context, which every client loads.

### 1.2 Trust boundaries

1. Vendor clouds ↔ public endpoint `{host}`.
2. Owner's browser ↔ authorization server (`{host}`) and admin UI (`admin.{host}`).
3. Coding agent (with a shell) ↔ local client, CLI and its token file.
4. Repository content ↔ the agent and the hooks.
5. Instance ↔ AWS control plane (IMDS, S3, KMS, SSM).
6. Server ↔ LLM vendor.
7. Server ↔ backups and exports.

### 1.3 Attackers

| Id | Attacker | Goal |
| --- | --- | --- |
| R1 | Internet scanner | Find and abuse endpoints |
| R2 | Stranger with their own Claude, ChatGPT, Gemini or Grok account | Obtain a grant to the owner's store |
| R3 | Author of content a connected model reads (web page, email, document, repo file, other app's tool output) | Plant memories (poisoning) or read them out (exfiltration) |
| L1 | Malicious repository the owner opens | Run hooks, shadow the server, exfiltrate |
| L2 | Compromised dependency or release | Code execution in the client or server |
| L3 | Same-user malware on the PC | Steal tokens, read caches |
| L4 | Prompt-injected coding agent with a shell | Use the CLI to dump or wipe the store |
| V1 | Vendor account takeover | Use the vendor's grant |
| I1 | The implementer building exactly what this spec says | Gaps become bugs |

Same-user malware (L3) cannot be fully defeated in user space. The goal is a bounded blast radius: no credential on the PC can dump, export or wipe the store without a passkey approval.

### 1.4 Threats and controls

| Threat | Example | Controls | Section | Eval case |
| --- | --- | --- | --- | --- |
| Consent phishing through a stranger's vendor account (R2) | Attacker connects their ChatGPT to `{host}`, sends the owner the `/authorize` link | Pairing window bound to the owner's browser (pair cookie or code); static client credentials for Claude, ChatGPT and Gemini, so no shared vendor client id is accepted by default; fresh passkey per consent; consent page shows vendor, exact redirect, registration time; one active grant per vendor; grant notice | §4 | S-OAUTH-01 |
| Open registration abuse (R1, R2) | Unlimited DCR, SSRF via metadata URLs, client update, racing the owner for the window's slot, probing for open windows | DCR only inside a pairing window; identical responses whether or not a window is open; a lost registration race closes the window and alerts; field allow-list; RFC 7592 off; ≤ 20 clients; unused clients deleted after 24 h | §4.1, §4.3 | S-OAUTH-02 |
| CIMD SSRF and prefix bypass | `client_id=https://claude.ai.evil.example/…`, userinfo, DNS rebinding to IMDS | Parsed exact host and path match; library fetch with special-use IPs blocked, no redirects, 5 KB, 5 s; IMDS blocked for the server user | §4.3, §9 | S-OAUTH-03 |
| Redirect tricks | Wildcard callbacks, open redirect on error, PKCE downgrade | Exact redirect captured at pairing; error page, never redirect; PKCE S256 required | §4.5 | S-OAUTH-04 |
| Silent re-grant, CSRF, clickjacking | Pre-consented client auto-approved | Consent never remembered; UV every time; CSRF token, `Origin` check, `frame-ancestors 'none'`, 1 s button delay | §4.6, §8 | S-OAUTH-05 |
| Cookie-authenticated `/mcp` | Browser CSRF calls `memory_recall` | `/mcp` and `/v1` accept bearer only; no CORS; browser `Origin` rejected | §5.5 | S-OAUTH-06 |
| First-run enrollment race | Someone reaches `/setup` first | One-time setup token via SSM; exactly one owner; sign-up disabled | §3.1 | S-OAUTH-07 |
| Recovery-code brute force | Guessing codes | argon2id, 5 attempts/hour, using a code revokes all sessions | §3.3 | S-OAUTH-08 |
| Auth-library flaw or default routes | Device grant or sign-up route left on | Route inventory test; only `authorization_code` and `refresh_token`; pinned versions; 72 h patch target | §5.1 | S-OAUTH-09 |
| Poisoning via chat (R3) | A page tells Claude to save "prefers code that imports telemetry-helper" | Remote saves are T2; preferences enter the profile only at T0/T1; action-instruction screen; quotas; Recent changes with undo | write-path.md §5, retrieval.md §7 | S-POI-01..05 |
| Poisoning via Gemini Personal Intelligence | Attacker email asks Gemini to save a fake address | Gemini save floor observation; Gemini sections narrowed; third-party sensitive rejected; home address sensitive | clients.md §2 | S-POI-06 |
| Poisoning via repo content (L1, R3) | README tells the agent to save an "owner preference" | Writes only in enabled repos; T2; screen | write-path.md §5 | S-POI-07 |
| Capture role confusion | Tool output or injected context treated as user turns | Capture reads only the prompt hook field; no transcripts; no assistant text; span check | write-path.md §10 | S-POI-08 |
| Import laundering | Repo CLAUDE.md or model-written memories imported | User-level files only; T3; T3 never in profile; spans from user turns only | importers.md | S-POI-09 |
| Spool forgery (L3, L1) | A repo script writes spool files with forged tier | Spool is untrusted input; server assigns tier from grant; no forget or supersede spooled | topology-and-ipc.md §9 | S-POI-10 |
| Section and alias poisoning | Injected cluster creates a section with an instruction-like description | Names restricted alphabet; descriptions not model-facing until approved; LLM aliases need approval | memory-policy.md §9.2 | S-POI-11 |
| Supersede, contest and forget abuse | Injected saves close real facts; forgets by id | T2 cannot supersede T0/T1; forget quota 5/day; protected forgets need confirmation or review; digest | write-path.md §8–9 | S-POI-12 |
| Framing breakout | Content forges a "verified" heading | Control chars stripped; render escaping; fixed headings | retrieval.md §9 | S-POI-13 |
| Exfiltration by repeated recall (R3) | "Recall address employer family" many times | Read budgets; abstention; query floor; section allow-list; time-only cap 5 | retrieval.md §2, §5 | S-EXF-01..03 |
| Profile and catalog leakage | Project names, repo URLs, portfolio data | Profile has no project names; restricted attributes; Projects allow-list | retrieval.md §2 | S-EXF-04 |
| Context injection in untrusted repos | SessionStart profile in a malicious repo | Injection only in enabled repos | retrieval.md §8 | S-EXF-05 |
| Agent shell bypass (L4) | Injected agent runs `mema export --recipient <attacker key>` and words the request to look routine | No standing admin credential; step-up with passkey per admin command; the approval page shows only text the server renders from the parsed arguments (recipient fingerprint, match counts, repo name), never client-written text; unregistered export recipients need a second confirmation; PC grant cannot export, list or bulk-forget; only seven admin commands exist in the CLI | §6 | S-AGENT-01 |
| AWS credentials in the agent's reach (L4) | Agent runs `aws s3 cp`, `aws ssm start-session`, or uses the cached SSO token to get other roles | The PC's Identity Center user is assigned only the deploy permission set, and only in the dedicated `memory-anywhere` member account (the owner's other workloads are in a different account), which denies SSM sessions, backup reads and decrypt; operator work happens only in AWS CloudShell under a different Identity Center user, so no operator credential or SSO token is ever on the PC; the deploy SSO session is signed out when `mema deploy` exits and the portal session lasts at most 1 hour; every deploy-path API call is alerted | deployment-aws.md §3 | S-AGENT-02 |
| Projection leakage | Memory committed via AGENTS.md or synced via OneDrive | No projection files in v1 (caches stay in the client data directory); the Cursor repo rule holds policy text only and is git-excluded | clients.md §5 | S-EXF-06 |
| Hook and server shadowing (L1) | Repo `.mcp.json` defines `memory-anywhere` | Doctor warnings; `disabledMcpjsonServers`; client never trusts repo config | clients.md §3.2 | S-LOCAL-01 |
| Token theft on the PC (L3) | Infostealer reads `tokens.json` | PC grant has no admin scope; repo-limited writes; 7-day idle and 30-day absolute refresh lifetime; one-click revoke | §5.6 | — (accepted residual) |
| SSRF to IMDS | Any fetch reaching 169.254.169.254 | IMDSv2 hop limit 1; iptables blocks server and Caddy users; server holds no AWS credentials | deployment-aws.md §4 | S-AWS-01 |
| Backup exposure or tampering | Leaked bucket, stolen role credentials | SSE-KMS CMK; bucket policy with `aws:SourceVpce`; no delete-version; hash chain; Object-Lock manifest from M4 | deployment-aws.md §5 | S-AWS-02 |
| Dangling DNS | Released IP reused by another tenant | Retained Elastic IP; `mema destroy` releases the IP only after the owner has deleted the Cloudflare records and public DNS no longer resolves them; CAA on the subdomain (optionally with accounturi) | deployment-aws.md §6 | S-AWS-03 |
| TLS ended by a CDN | A proxied (orange-cloud) Cloudflare record lets Cloudflare see tokens and memory content | Records are DNS only; `mema deploy` and `mema doctor` fail if `{host}` does not resolve to the Elastic IP itself | deployment-aws.md §6.2 | S-AWS-04 |
| Stored XSS, CSRF, clickjacking in admin UI | Memory content with `<script>` | Separate origin; text-only rendering; CSP; cookies; CSRF | §8 | S-WEB-01..04 |
| Origin confusion | `curl -H 'X-MA-Origin: admin' https://{host}/…` reaches the admin router | Caddy overwrites `X-MA-Origin` on both sites (`mcp` on `{host}`, `admin` on `admin.{host}`); the server treats any value other than `admin` as MCP | §2, deployment-aws.md §4 | S-WEB-05 |
| Denial of wallet | CPU floods, LLM spend | Standard credits; per-IP limits; LLM caps; response caps | operations.md §3 | S-DOW-01 |
| Deletion residue | Purged text in FTS, WAL, Litestream staging, pre-update copies, excerpts, backups | Purge scope; secure_delete; nightly maintenance checkpoint; pre-update and pre-migration copies deleted after 24 h; backups within 30 days | data-model.md §9, deployment-aws.md §5 | S-PURGE |
| Re-learning purged facts | Vendor memory re-imported | Suppression HMAC | write-path.md §9 | S-PURGE-02 |
| Vendor account takeover (V1) | Someone in the owner's Google account | Accepted. Vendor passkeys recommended; one-click revoke; Gemini narrowed; no sensitive data to remote clients by default | §10 | — |

### 1.5 Accepted risks (stated in the README)

- Anthropic, OpenAI, Google and xAI see whatever a model recalls or saves in their apps, under their own retention and training settings. Google requires Keep Activity for custom apps; activity auto-deletes after 18 months by default (settable to 3), a subset of chats is human-reviewed, and reviewed chats are kept up to 3 years ([Gemini privacy](https://support.google.com/gemini/answer/13594961)). Recommendation printed by `mema init`: set Gemini auto-delete to 3 months; keep sensitive categories off for every remote client.
- Gemini may pass content from the owner's email, Connected Apps and Personal Intelligence, including other people's messages, into tool arguments.
- The LLM vendor configured for extraction sees redacted user prompts from enabled repos and imported history.
- Same-user malware on the PC can use the PC grant within its limits until revoked.
- While the owner is signed in to the deploy SSO session (at most 1 hour, during a deploy the owner starts), a hijacked agent on the PC could change the instance through CloudFormation (for example its user data) and so reach the data. Every such API call raises an immediate alert (deployment-aws.md §2), and `mema deploy` signs the session out when it exits.
- AWS operates KMS; SSE-KMS protects against a leaked bucket, not against AWS.
- Let's Encrypt and Certificate Transparency logs publish the hostname. The hostname is not a secret, and no control depends on it being unknown.
- Cloudflare hosts the owner's DNS zone. It sees DNS queries for `{host}` but no traffic, because the records are DNS only; a Cloudflare account takeover could repoint the records, which TLS (the attacker cannot get a certificate while CAA and the retained IP hold) and the pairing window contain.

### 1.6 Controls considered and not used

- **Vendor IP allow-lists** on `/mcp` and `/token` are not used. OpenAI says an IP allow-list "does not replace request authentication or authorization" and its ranges change ([OpenAI IP addresses](https://developers.openai.com/api/docs/guides/ip-addresses)); Google publishes no Gemini egress list; a stranger's vendor account calls from the same ranges; the PC calls from a home IP. The pairing window (§4) is the control that separates the owner's vendor account from a stranger's.
- **DPoP or TPM-bound PC tokens** are not used (ADR-0006).

## 2. Origins and endpoints

| Origin | Serves | Auth |
| --- | --- | --- |
| `https://{host}` | `/mcp`, `/v1/*`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (both routed by the host app to the OAuth provider, which is mounted at `/oauth`), `/oauth/*` (the provider's routes: auth, token, reg, revocation, jwks), `/pair/*`, `/consent/*`, `/setup`, `/recover` | Bearer for `/mcp` and `/v1`; AS cookie for `/oauth`, `/pair` and `/consent` pages |
| `https://admin.{host}` | Admin UI and its JSON API under `/api/*` | Admin session cookie |

Both names are served by the same process through Caddy (two site blocks, one upstream). Caddy sets the request header `X-MA-Origin` on every request, overwriting any value the client sent: `mcp` in the `{host}` block, `admin` in the `admin.{host}` block (deployment-aws.md §4). The server routes to the admin router only when the header is exactly `admin` and the request arrived on the unix socket; any other value is treated as MCP. The admin origin never serves `/mcp` and the MCP origin never serves admin pages. In local mode the admin UI is served under `http://127.0.0.1:47821/admin/` (topology-and-ipc.md §4).

## 3. Owner authentication

Passkey only, with recovery codes. No password, no email, no sign-up.

### 3.1 Bootstrap

1. `mema deploy aws` (deployment-aws.md §7) creates the instance. On first start (no owner row) the server generates a setup token (32 random bytes, base64url), stores its sha256 in `setup_token` with `expires_at` = start + 30 minutes, and writes the plaintext to the outbox, which stores it in SSM Parameter Store `/memory-anywhere/setup-token` (SecureString) (deployment-aws.md §4). The owner reads it in AWS CloudShell with `ma-operator setup-link`, which prints `https://admin.{host}/setup#<token>`. (The deploy profile on the PC cannot read it.)
2. `/setup` accepts the token once. It enrolls the first passkey (WebAuthn registration with the parameters in §3.2) and creates the `owner` row (id 1; a second insert fails by constraint).
3. Immediately after, the setup page requires a **second passkey**. The two must differ in authenticator AAGUID (different provider, for example a hardware key and Windows Hello, or iCloud Keychain and Google Password Manager), or at least one must have the backup-eligible flag clear (device-bound). The page tells the owner not to keep both passkeys in the Google account used for Gemini, because a takeover of that account would then also unlock the admin UI. Pairing stays disabled until two passkeys exist.
4. The page shows 10 recovery codes once (§3.3) and requires the owner to type one back.
5. The setup token row is marked used and the SSM parameter is deleted (outbox `setup-token.delete`).
6. **Renewal.** The first token often expires before the owner can use it (DNS records, the certificate and the CloudShell sign-in all come first). `./ma-operator.sh setup-link` therefore checks the token's expiry and, if it is missing or expired, runs `memory-anywhere-server setup-token --renew` on the instance through SSM Run Command, which invalidates any old token and issues a fresh 30-minute one. `--renew` works only while the store has no owner (first setup) or after an executed owner reset; otherwise it refuses. A server restart does not create a token.

### 3.2 WebAuthn parameters

| Item | Value |
| --- | --- |
| Library | `@simplewebauthn/server` (pinned exact) |
| RP ID | `{host}` (registrable parent of `admin.{host}`; both origins can use the credential) |
| Allowed origins | `https://admin.{host}`, `https://{host}` (consent pages) |
| User verification | `required` on every registration and assertion |
| Resident key | `required` |
| Attestation | `none` |
| Algorithms | ES256, EdDSA, RS256 |
| Challenge | 32 random bytes, single use, 2-minute lifetime, bound to the session |
| Sign count | Stored; a decrease raises alert `passkey_clone` and blocks that credential until the owner re-confirms with another passkey |

### 3.3 Recovery

- 10 codes, each 16 base32 chars in 4 groups, stored as argon2id (m = 64 MiB, t = 3, p = 1).
- Use: `/recover` page accepts a code. Rate limit 5 attempts per hour per IP and 10 per day globally. A valid code: marks the code used, revokes every admin session and every passkey, and opens a 30-minute enrollment for two new passkeys. All OAuth grants remain but a digest alert is sent.
- New codes: admin UI "Regenerate recovery codes" (step-up) invalidates the old batch.
- Break-glass when all passkeys and codes are lost: the owner runs `ma-operator reset-owner` in AWS CloudShell as the operator Identity Center user (deployment-aws.md §3.2). It uses SSM Run Command to call `memory-anywhere-server reset-owner --schedule` on the instance, which:
  1. records an `owner_reset` row with `effective_at` = now + 24 hours;
  2. sends an immediate alert `owner_reset_requested` by email (SNS via the outbox) and shows a banner in the admin UI, with a **Cancel** button that needs an existing passkey; the operator can also cancel with `ma-operator reset-owner --cancel`;
  3. at `effective_at`, if not cancelled, revokes all passkeys, sessions, recovery codes and OAuth grants (break-glass implies possible compromise) and enables setup-token renewal; it writes no token itself, so nothing expires unused overnight. The owner runs `./ma-operator.sh setup-link` in CloudShell when ready, which issues a fresh token (§3.1 step 6), and enrolls two new passkeys.
  The 24-hour delay means a stolen operator session cannot take over the store silently.

### 3.4 Admin sessions

- Cookie `__Host-ma_admin`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, on `admin.{host}`. Value 32 random bytes; stored as sha256 in `admin_session`.
- Idle timeout 30 minutes; absolute 12 hours.
- Step-up: these actions require a user-verified assertion within the last 5 minutes (`admin_session.uv_at`), otherwise the UI prompts for one: export, import commit, bulk forget, purge, revert, review approve of `instruction` and `sensitive` items, passkey add or remove, recovery regeneration, pairing, client policy changes, grant revoke, policy set, export-recipient changes, approving step-up requests from the CLI.

## 4. Pairing and client registration

### 4.1 Pairing window

No client can register or obtain a grant unless the owner opened a pairing window.

1. Owner: admin UI → **Connect a new app** → choose vendor (Claude, ChatGPT, Gemini, Grok, Claude Code (direct), PC, Other) → passkey step-up.
2. Server creates `pairing_window` (10 minutes) with an 8-character `pair_code`. For the chosen vendor it allows exactly **one** registration (if the method needs one) and **one** grant.
3. **Binding to the owner's browser.** The admin UI then navigates the same browser to `https://{host}/pair/<window id>?t=<one-time value>`, which sets the cookie `__Host-ma_pair` (`Secure`, `HttpOnly`, `SameSite=Lax`, 10 minutes) on `{host}` and returns to the admin UI. The consent page (§4.6) for that window requires either this cookie or the owner typing the `pair_code` shown in the admin UI (for example when the vendor flow opens in a different browser or on the phone).
4. **No observable state.** Requests to `/oauth/reg`, `/oauth/auth` and `/oauth/token` that fail for any reason, including "no open window", get the same response body, status and headers (`invalid_request`, or the same HTML error page) as any other invalid request, and are never redirected. An unauthenticated prober cannot tell whether a window is open.
5. **Registration race.** If a second registration arrives for an open window that already used its registration slot, or a registration's redirect does not match the window's vendor, the window closes (`close_reason = registration_race`) and alert `pairing_race` fires. The owner opens a new window.
6. The window closes on first grant, on expiry, on a race, or when the owner cancels.
7. At most one active grant per vendor (for vendor PC: one per named machine; the owner names the machine when opening the window). Pairing a vendor that already has a grant requires choosing "Replace", which revokes the old grant when the new one is issued.
8. Every new grant creates alert `grant_created` (immediate email and digest).

### 4.2 Methods per vendor

Static credentials are the default wherever the vendor's connector form accepts them, because a static client id and secret exist only for the owner's connector; a shared vendor client id (CIMD) or an open DCR endpoint can be presented by any user of that vendor. DCR is deprecated in MCP 2026-07-28 and is used only as a fallback inside a window.

| Vendor | Method (decided in M0) | What the admin UI shows | Fallback order |
| --- | --- | --- | --- |
| Claude (web, desktop, mobile) | Static confidential client created at window open; redirect `https://claude.ai/api/mcp/auth_callback`. Claude's custom-connector dialog accepts an OAuth client ID and optional secret ([Claude connector auth](https://www.claude.com/docs/connectors/building/authentication)) | MCP URL, client id, client secret (shown once) | DCR. Static works (ADR-0103), so Claude's hosted CIMD client id was never needed or recorded; CIMD for Claude stays off |
| ChatGPT | Static confidential client created at window open, redirect `https://chatgpt.com/connector_platform_oauth_redirect`, `client_secret_basic` (works, ADR-0102) | MCP URL, client id, client secret (shown once) | CIMD (`https://chatgpt.com/oauth/client.json` or `https://chatgpt.com/oauth/<callback_id>/client.json`) → DCR |
| Gemini | Static confidential client entered under Developer Mode → Connect to an MCP server → Additional settings (works, ADR-0107). The redirect is per user and server: `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<Google user id>-<host with dots as underscores>`, accepted by that rule (`config/vendors.json`) | MCP URL, client id, client secret (shown once) | DCR inside the window |
| Grok | DCR inside the window: Grok's dialog takes only a name and URL (ADR-0108). Public client (`none`, PKCE), redirect `https://grok.com/connectors-oauth-exchange-code/`, `application_type` omitted (`web`, spec-issues #19) | MCP URL | none |
| Claude Code (direct) | CIMD with Claude Code's public client id `https://claude.ai/oauth/claude-code-client-metadata` and a loopback redirect. Only for a Claude Code that connects to `/mcp` over HTTP without the plugin; the plugin path (stdio proxy + PC grant) is recommended | MCP URL, plus a warning that any program on that computer could claim this client during the window | none |
| PC (`mema login`) | Built-in public client `memory-anywhere-cli` with loopback redirect | a pairing code | none |
| Other | Static credentials, or DCR inside the window; for a desktop app with a loopback redirect the owner ticks "desktop app on my computer" | per method | |

ChatGPT's redirect is `https://chatgpt.com/connector_platform_oauth_redirect` for servers that are issuer-identification compliant, or `https://chatgpt.com/connector/oauth/{callback_id}`; CIMD documents are at `https://chatgpt.com/oauth/client.json` or `.../oauth/{callback_id}/client.json`; ChatGPT needs S256 and supports `none` or `private_key_jwt` for CIMD ([OpenAI auth](https://developers.openai.com/apps-sdk/build/auth)). The server emits `iss` and advertises it, so the stable redirect is used.

The **static bearer** method (only if a vendor supports no OAuth; no vendor tested in M0 needs it, so it is not built in v1) creates a random 32-byte token with scopes `memory.read memory.write`, stored hashed, valid 90 days, revocable, entered by the owner in the vendor's header field. It is listed as a weaker method in the admin UI.

Client policy defaults: Claude Code (direct) and Other desktop apps get class `chat` (they send no repo key), the narrowed section list and `save_floor = observation`, like generic clients (§4.4).

### 4.3 CIMD and DCR rules

CIMD:
- The `client_id` URL must parse as https, with no userinfo, no explicit port, no query and no fragment; host in an exact set; path matching that host's exact pattern. Initial set: `claude.ai` path `^/oauth/claude-code-client-metadata$` (Claude Code direct), `chatgpt.com` paths `^/oauth/client\.json$` and `^/oauth/[A-Za-z0-9_-]{1,64}/client\.json$`. Codex is not listed: Codex connects through the stdio proxy and the PC grant.
- Fetched by the library transport: one DNS resolution, special-use and private addresses rejected, no redirects, 5 KB limit, 5 s timeout. The metadata's `redirect_uris` must contain the redirect used in the request, exactly.
- CIMD is accepted only inside a pairing window for that vendor, and only for the exact `client_id` URL recorded for that vendor in `config/vendors.json` (M0 Q03, Q04).
- Redirect URIs must be https on the vendor's redirect host set, except loopback redirects (`http://127.0.0.1:<port>/…`, `http://localhost:<port>/…`), which are accepted only for `memory-anywhere-cli`, the Claude Code (direct) CIMD client, and an Other window opened as "desktop app on my computer".

DCR:
- Only inside a pairing window. Accepted fields: `redirect_uris` (1–2 entries), `client_name` (≤ 64 chars), `grant_types` (`authorization_code`, `refresh_token`), `response_types` (`code`), `token_endpoint_auth_method` (`none`, `client_secret_post`, `client_secret_basic`), `application_type` (`web` for https redirects; `native` only for a loopback redirect in a "desktop app" window; any mismatch or missing value is rejected). Any other field (`jwks_uri`, `logo_uri`, `sector_identifier_uri`, `request_uris`, `policy_uri`, `tos_uri`, …) rejects the request.
- Every https redirect URI must be on a host in the vendor's redirect host set (`claude.ai`, `chatgpt.com`, `oauth-redirect.googleusercontent.com` for Gemini under the rule above, `grok.com` for Grok; for vendor Other, the single https host the owner types when opening the window).
- RFC 7592 client configuration endpoint disabled.
- At most 20 registered clients. A client with no grant 24 hours after registration is deleted.

### 4.4 Generic MCP clients ("Other")

Any client following the MCP authorization spec works through DCR or static credentials inside a window. The owner chooses read-only or read-write and the section allow-list at pairing. Defaults: class chat, read-write, sections Profile, Preferences, Interests, Tools and setup, save floor observation.

### 4.5 Authorization requests

- PKCE S256 required on every request; `plain` or a missing challenge → error page.
- `resource` parameter required and equal to `https://{host}/mcp` (RFC 8707); tokens are audience-bound to it.
- `redirect_uri` must equal, character for character, a registered URI of the client. Loopback URIs (only for the clients listed in §4.3) match any port for `127.0.0.1` and `localhost` ([Claude auth](https://www.claude.com/docs/connectors/building/authentication)).
- Invalid `client_id` or `redirect_uri` → error page, never a redirect (RFC 9700 §2.1).
- Authorization codes: single use, 60-second lifetime; reuse revokes tokens issued from that code.
- `iss` included in authorization responses; `authorization_response_iss_parameter_supported: true` advertised.
- The authorization response page loads no third-party resources.

### 4.6 Consent page

Shown on every authorization; consent is never remembered. Content:
- Vendor name (from the pairing window), the verified redirect host in large text, and the full redirect URI.
- `client_name` labelled "self-declared".
- Registration time of the client ("registered 2 minutes ago").
- Scopes in plain words ("read and save memories").
- The question "Did you just click Connect in <vendor> yourself?" with **Approve with passkey** and **Deny**.
- Approve requires a WebAuthn assertion with UV performed on that page. The button is disabled for 1 s after load.
- The window's `__Host-ma_pair` cookie, or the window's 8-character `pair_code` typed by the owner (§4.1). Without either, the page shows only "Enter the code shown in your admin UI".
- CSRF token, `Origin` and `Sec-Fetch-Site: same-origin` check, `frame-ancestors 'none'`.

### 4.7 Discovery metadata

Protected resource metadata at `/.well-known/oauth-protected-resource/mcp`:

```json
{ "resource": "https://{host}/mcp",
  "authorization_servers": ["https://{host}"],
  "scopes_supported": ["memory.read", "memory.write"],
  "bearer_methods_supported": ["header"] }
```

node-oidc-provider publishes its metadata at `/.well-known/openid-configuration` under its mount path. The host application mounts the provider at `/oauth` and routes both `https://{host}/.well-known/oauth-authorization-server` and `https://{host}/.well-known/openid-configuration` to the provider's discovery handler, so the issuer stays `https://{host}`. `packages/server/test/routes.allow.txt` starts with the provider's mandatory routes (both discovery paths, `/oauth/auth`, `/oauth/token`, `/oauth/reg`, `/oauth/token/revocation`, `/oauth/jwks`, the interaction routes under `/oauth/interaction/*`) plus this server's own routes, so the route-inventory test passes on day one. Authorization-server metadata advertises at least: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` (responds only inside windows), `revocation_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none","client_secret_post","client_secret_basic"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `scopes_supported: ["memory.read","memory.write","memory.capture","offline_access"]`.

Claude uses CIMD only if the metadata has `client_id_metadata_document_supported: true` and `none` in token auth methods, uses only the first authorization server, and requires discovery, registration and token responses within 10 s and refresh within 30 s ([Claude auth](https://www.claude.com/docs/connectors/building/authentication)).

## 5. Tokens

### 5.1 Library

**node-oidc-provider** (`oidc-provider` ~9.13, pinned with `~` because its experimental CIMD feature can change in minor versions) is the default authorization server and the only one spiked in M0. **Better Auth** (`better-auth` + `@better-auth/mcp`) is spiked only if node-oidc-provider fails a test in the M0 conformance list (Q15). Rationale: ADR-0004. The owner login, consent page, pairing and step-up are memory-anywhere code on top of the library; passkeys use `@simplewebauthn/server` with either library.

Enabled features: authorization code with PKCE, refresh token, resource indicators, CIMD (experimental), registration (gated by pairing), revocation, `iss` in responses. Disabled: implicit, password, client credentials, device authorization, token exchange, introspection to third parties, RFC 7592, `request_uri`, end-session pages, userinfo. CI runs a route-inventory test: every route the process answers must be on `packages/server/test/routes.allow.txt`; any other route answering non-404 fails the build.

### 5.2 Formats

| Token | Format | Lifetime | Storage |
| --- | --- | --- | --- |
| Access token | Opaque, 32 random bytes base64url (library `accessTokenFormat: 'opaque'`) | 1 hour | `oidc_store` keyed by sha256 of the value (the adapter hashes ids for `AccessToken`, `RefreshToken`, `AuthorizationCode`, `ClientCredentials`) |
| Refresh token | Opaque | PC (public): 30 days absolute, 7 days idle. Public CIMD/DCR clients (fallbacks, Claude Code direct): 90 days absolute, 30 days idle. Static confidential vendor clients (Claude, ChatGPT, Gemini): 180 days absolute, 30 days idle, since they authenticate at `/token` and each re-pair needs a window and a passkey | same |
| Authorization code | Opaque | 60 s, single use | same |
| Step-up admin token | Opaque, `mst_` + 32 bytes | 10 minutes, single use, bound to one command and `args_sha256`; `import`: 60 minutes, multi-use, bound to one `import_batch` | `stepup_request.token_hash` |
| Static bearer (fallback) | Opaque, `msb_` + 32 bytes | 90 days | `client_policy`-linked row in `oidc_store` (model `StaticBearer`) |
| Local-mode token | 32 bytes base64url | until rotated | `local.token` file |

If the fallback library (Better Auth) is chosen, its JWT access tokens are accepted only with: `aud` = `https://{host}/mcp`, lifetime ≤ 1 hour, `refreshTokenReuseInterval: 0`, and a server-side revocation list checked on every request (ADR-0004 records this).

### 5.3 Refresh rotation

| Client type | Policy |
| --- | --- |
| Public (PC, Claude Code direct, any CIMD/DCR fallback) | Rotate on every use. Within 30 s of a rotation, presenting the previous refresh token returns the same new pair (handles Claude's concurrent refresh). After 30 s, reuse revokes the whole grant and raises alert `refresh_reuse` |
| Confidential (Claude static, ChatGPT static, Gemini static) | `client_policy.refresh_rotation` per vendor. Claude: `rotate` with the same 30 s grace window (Claude refreshes concurrently, up to five minutes before expiry). Gemini: `fixed` (Google's connected-apps guidance says not to rotate refresh tokens; [Google OAuth for connected apps](https://developers.google.com/connected-apps/mcp/oauth)), which RFC 9700 permits for confidential clients that authenticate at `/token`. ChatGPT: `rotate` (M0: its refreshes succeed with rotation, ADR-0102). Gemini rotation was also tested and works (ADR-0107). Grok is a public DCR client and rotates as in the row above |

A dead or revoked refresh token returns `invalid_grant`.

### 5.4 Scopes

mcp-interface.md §6. `memory.admin` is never grantable through `/authorize`.

### 5.5 Resource server rules

- `/mcp` and `/v1` accept `Authorization: Bearer` only. Cookies are ignored. No CORS headers. Requests with an `Origin` header whose value is a browser origin (anything other than absent or `null`) are rejected with 403.
- The token's audience must equal `https://{host}/mcp`.
- The grant's `client_policy` row must not be revoked.
- 401 responses carry `WWW-Authenticate: Bearer resource_metadata="…", scope="memory.read memory.write"`.

### 5.6 The PC grant

- `mema login` runs authorization code + PKCE with client `memory-anywhere-cli` (a public client pre-registered by `memory-anywhere-server init`) and a loopback redirect `http://127.0.0.1:<ephemeral>/callback`. Before it starts, the owner opens a PC pairing window in the admin UI; `mema login` prints an 8-character code, and the consent page shows the same code so the owner can match them.
- Scopes `memory.read memory.write memory.capture`. Class `coding`.
- Stored in `{data}\tokens.json` (topology-and-ipc.md §10). Not in Windows Credential Manager, because the client has no native modules (ADR-0006). The file holds no admin capability.
- Writes are accepted only with an enabled `MA-Repo-Key` (mcp-interface.md §6). A stolen PC token can therefore save at T2 into enabled repos and recall within the coding read budget. It cannot export, list, bulk-forget, purge, review, revert, change policy or pair.
- One PC grant per machine. `mema logout` revokes it.

## 6. Admin operations and coding-agent containment

### 6.1 Rule

No admin credential is stored on any PC. Every admin CLI command needs a fresh passkey approval. (Local mode is the exception: there the local token is the owner credential, topology-and-ipc.md §4.)

### 6.2 Step-up flow

The CLI has seven admin commands (config-and-cli.md §4.2). Everything else the owner does is in the admin UI, which already holds a passkey session. Fewer approvals keeps each one meaningful.

1. The CLI calls `POST /v1/admin/stepup` with the PC grant: `{command, args}`, where `args` are the command's canonical arguments (≤ 4 KiB, validated against the command's schema). There is no client-written summary field.
2. The server validates `args`, computes `args_sha256`, and **renders the approval text itself** from the parsed arguments and its own data (stored in `stepup_request.rendered_text`):

| Command | The approval page shows |
| --- | --- |
| `repo-enable` | Repo display name, remote host, whether capture will be on, and whether a project will be tracked |
| `repo-disable` | Repo display name, remote host |
| `project-track`, `project-add` | Project name, aliases, status, goal, and the repo display name if any |
| `export` | Export kind (full, full with auth, projects); the recipient's label and fingerprint (first 16 hex of sha256 of the recipient, in four groups); the number of memories that will be included, computed by the server; the output path as reported by the computer, labelled so |
| `import` | Source type, file SHA-256 (first 16 hex), item count, estimated cost (from `/v1/import/estimate`) |
| `review` | Each item to approve or reject, with its kind and the first 200 characters of its content, escaped |

   For `export` to a recipient that is **not** in `export_recipient`, the page shows a red warning "This key is not one of your registered export keys", the full fingerprint, and requires the owner to type its last 8 hex characters and then complete a second passkey assertion (`needs_second_confirm = 1`). `--include-auth` exports show a second warning that the file can take over the store.
3. The server returns `user_code` (8 chars, base32, no ambiguous letters) and `approve_url` = `https://admin.{host}/approve/<request_id>`. The CLI prints the user code and the URL and opens the URL in the default browser (`--no-browser` prints only).
4. The owner checks the code matches, reads the rendered text, and approves with a passkey (UV).
5. The CLI polls `GET /v1/admin/stepup/<id>` every 2 s. On approval it receives a step-up token bound to the command and `args_sha256`. The server rejects any `/v1/admin/<command>` call whose arguments do not hash to the approved value.
6. Token lifetime and use: single use, 10 minutes, for every command except `import`. An `import` token is bound to one `import_batch` id, multi-use, valid for 60 minutes (write-path.md §10.5). Tokens live only in the CLI process's memory.

An injected coding agent can start a step-up request but cannot approve it, and it cannot change what the approval page says. Repeated denied or expired requests (3 in 1 hour) raise alert `stepup_unexpected`.

### 6.3 Defence in depth (not the boundary)

- `mema doctor` lists hooks that call the CLI and were not installed by it.
- The PC never holds operator AWS credentials; the deploy profile has its own SSO session that `mema deploy` signs out on exit (deployment-aws.md §3).

## 7. Untrusted inputs

| Input | Treated as | Rule |
| --- | --- | --- |
| Tool arguments from any client | Untrusted | Schema, screens, tiers |
| `MA-Tool`, `MA-Session`, hook `session_id` | Labels | Used for grouping and display only |
| `MA-Repo-Key` | Claim from the PC grant holder | Bounds writes and repo scope; cannot raise tier |
| Spool files | Untrusted | Server assigns tier and source; ignores other fields; no forget or supersede; replays count against quotas |
| CIMD documents, DCR bodies | Untrusted | §4.3 |
| Imported files | Untrusted | importers.md; T3 |
| Memory content at render | Untrusted | retrieval.md §9; admin UI renders as text (§8) |

## 8. Web surfaces

Applies to the admin UI, consent, setup, recovery and approval pages.

- Server-rendered templates with auto-escaping (`eta` or equivalent with `autoEscape: true`), plus a small first-party script bundle. No Markdown or HTML rendering of stored strings: memory content, excerpts, `user_words`, client names, section names and aliases are inserted as text nodes only.
- Every HTML response sends:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=31536000
Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self)
```

- No third-party resources (fonts, scripts, images, analytics) on any page.
- Cookies: admin `__Host-ma_admin` (`SameSite=Strict`); AS interaction `__Host-ma_as` (`SameSite=Lax`, needed for the vendor redirect back). Both `Secure`, `HttpOnly`.
- Every state-changing request (POST, PUT, DELETE) checks a synchronizer CSRF token and requires `Sec-Fetch-Site: same-origin` (or, if absent, an `Origin` equal to the page's origin).
- The admin JSON API under `admin.{host}/api/*` requires the session cookie and the CSRF header `X-MA-CSRF`; it has no CORS.
- The admin UI is mobile-first and works on the phone browser.

### 8.1 Admin UI v1 scope (M2)

Passkey login and recovery; setup; search and browse by section and entity; memory detail with version history, sources and tiers; edit (T0 new version), pin, forget, undo, purge; contested items with resolve; review queue (instruction, sensitive with the choice of recalling clients, import sensitive, render-time sensitive, protected forget, preference confirmations, project proposals, section and alias proposals); observations (list, promote, forget); Recent changes feed with undo; per-client activity, read-budget use, bad-save rate and revert by client and time window; client policies and grants (pairing, revoke); sections (approve, rename, undo, merge); attributes (add); repos (enable, disable, capture on/off); LLM spend; health, alerts and digest settings; step-up approvals; registered export recipients (add or revoke an age public key with a passkey); a list of issued exports (time, kind, recipient fingerprint, requesting machine); a pending owner reset with Cancel. Export itself is CLI only (step-up). In local mode the same UI runs at `http://127.0.0.1:47821/admin/`, opened by `mema ui`, which exchanges the local token for a session cookie through a one-time link; there are no passkeys in local mode.

## 9. Server process containment (AWS)

- The server runs as user `memory-anywhere` with no shell, under systemd with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=/var/lib/memory-anywhere /run/memory-anywhere`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `CapabilityBoundingSet=` (empty), `SystemCallFilter=@system-service`, `MemoryMax=1400M`.
- It listens on the unix socket `/run/memory-anywhere/http.sock` (mode 0660, group `caddy`). Caddy proxies to it and replaces `X-Forwarded-For` with the client address; the server trusts only that header, only from the socket.
- It holds no AWS credentials. iptables rules block `169.254.169.254` for users `memory-anywhere` and `caddy` (deployment-aws.md §4).
- The LLM key arrives in `/run/memory-anywhere/secrets.env` from the oneshot secrets service; the cookie and MRTR secrets are generated by the server and kept in `meta`. Everything it must send to AWS (setup token, alert emails, and from M4 the daily manifests) goes through the outbox helper (deployment-aws.md §4), which runs a fixed upload script under user `ma-aws`.

## 10. Supply chain

| Item | Rule |
| --- | --- |
| Dependencies | Exact versions; `pnpm install --frozen-lockfile`; pnpm `onlyBuiltDependencies: ["better-sqlite3", "onnxruntime-node", "argon2"]` (server only); the client package has zero install scripts and zero native modules; `npm audit signatures` in CI |
| Releases | Server tarballs are built and minisign-signed only by a tag-triggered GitHub workflow in an environment that needs manual approval (from M2); npm publishing with trusted publishing and provenance from M5; hardware-key 2FA on GitHub and npm; SHA-256 sums published for every artifact. Signing keys: deployment-aws.md §7.4, ADR-0021 |
| Plugins | Marketplace manifests pin a tag and commit SHA; the README tells users to turn off auto-update for this plugin; Codex re-review on hook change is relied on |
| Embedding model | Pinned Hugging Face revision and per-file SHA-256 in `packages/server/models.json`; verified at load |
| Auth library | Chosen partly on advisory history (M0 Q15 checks GHSA, not aggregators); GHSA subscription; High or Critical patched within 72 hours |
| Caddy | Official release binary, pinned version and checksum, no plugins, `admin off` |
| Litestream | Official release, pinned version and checksum |
| Node | Official tarball, pinned version and checksum |

## 11. Data protection summary

| Data | Protection |
| --- | --- |
| Live DB (AWS) | EBS encrypted with the customer-managed KMS key; `secure_delete` on |
| Live DB (local mode) | OS disk encryption (BitLocker / FileVault / LUKS) recommended; README states it |
| Backups | SSE-KMS (Litestream v0.5 has no client-side encryption; [Litestream config](https://litestream.io/reference/config/)) plus bucket and key policies |
| Exports | age, encrypted by the server to a registered recipient public key (or a second-confirmed one); the identity is kept offline |
| Audit | Query HMAC (key rotated every 90 days), result ids, client, IP /24; 90-day retention |
| Logs | No content (operations.md §1) |
