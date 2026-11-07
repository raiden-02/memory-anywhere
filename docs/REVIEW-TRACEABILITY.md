# Review traceability

Every finding from the second-round reviews, plus every first-round Critical/High finding, mapped to where v3 resolves it or why it was rejected. Nothing is dropped silently.

Sources:
- **R2A** = review2-architecture.md (N1–N32, contradictions C1–C27, missing specs M1–M29, status of v1 findings).
- **R2S** = review2-security.md (claims table, attack paths P/E/O/A/H/S/W/D/B/X, privacy, D-0..D-18, top-10 risks, open items).
- **R2F** = review2-factcheck-build.md (claims rows, section B facts, buildability gaps C0/M0/M1).
- **R1A** = review-architecture.md (v1), **R1F** = factcheck.md (v1).
- **R3** = review3-audit.md (round-3 audit of v3: blockers B1–B5, should-fixes SF1–SF33, traceability failures, contradictions, fact checks, over-engineering items OE1–OE10, recommendations, owner questions), plus the coordinator's owner-level directives (section 14.9).
- **R4** = review4-recheck.md (round-4 re-check: blockers R4-B1–B3, should-fixes R4-S1–S16), plus the owner's context for R4-B1 (section 15).
- **R5** = review5-final.md (final re-check: blocker R5-B1, should-fixes R5-S1–S6) (section 16).

Status values: **Adopted**; **Adopted (modified)**: the finding is fixed, differently from the proposal (reason given); **Rejected** (reason given); **M0**: decided by a spike question with a fallback already specified; **Moot**: the v3 design removed the thing the finding was about.

File abbreviations: TOP topology-and-ipc.md, DM data-model.md, POL memory-policy.md, WP write-path.md, RET retrieval.md, MCP mcp-interface.md, CLI clients.md, SEC auth-and-security.md, AWS deployment-aws.md, CFG config-and-cli.md, OPS operations.md, EV evals.md, IMP importers.md, M0 m0-spike.md, D DESIGN.md. ADRs are in `decisions/`.

## 1. R2A new findings N1–N32

| Id | Finding | Status | Where |
| --- | --- | --- | --- |
| N1 | Owner topology undefined and self-contradictory | Adopted | TOP §1–3; D §4.1; ADR-0001. No PC daemon; M1 local mode with throwaway data; owner store starts in M2 |
| N2 | No deterministic save→outcome mapping; uncomputable rules | Adopted (modified) | WP §5 (rows D1–D19), §5.1. Short-lived wording is rejected with a hint (not observation); "dwell" removed; pending_review never recalled, profile shows count |
| N3 | Preference vs instruction overlap sends preferences to review | Adopted (modified) | POL §3.1–3.2 (deterministic action-instruction screen); ADR-0003: preferences active at once (recall) but in the profile only at T0/T1, reconciling N3 with R2S D-1 |
| N4 | Coding agents bypass the five-tool boundary via the CLI admin token | Adopted (modified) | SEC §5.6, §6. No admin credential on the PC; per-command passkey step-up through the admin UI (a device-code-like flow); one PC grant (read/write/capture), not separate client and capture tokens; tokens in a user-ACL'd file (ADR-0006) |
| N5 | T1 asserted by the model | Adopted (modified) | ADR-0002, DM §7. T1v/T1c rejected: a prompt substring does not prove the user means it (pasted text). T1 only via verified elicitation; prompt-log check kept to discard invented `user_words` (WP §4 step 5) |
| N6 | Corrections and changes written the same way | Adopted | DM §6 (update, correction, historical, extension, forget); MCP §3.3 `change` |
| N7 | Historical facts trigger false contests; forgotten facts return; rule order | Adopted (modified) | WP §8 rules 0–7 (rule 0 first, rules 2–3 historical), §9.2 suppression; DM `suppression`. A suppressed fact is rejected (or re-confirmed by elicitation) instead of going to review at T1, since T1 now means a human confirmation (WP §5 D7–D8) |
| N8 | No slot vocabulary; cardinality on wrong row; project table bypasses write path; section_id missing | Adopted | DM §2 `attribute`, §4.2 seeds, §3 `project_view`, `memory.section_id`; POL §9.1 placement; `section` optional in MCP §3.3 |
| N9 | LLM uses lack host, model, key, timeout, fallback, cost cap | Adopted (modified) | WP §6.2; ADR-0007. Key delivered by a separate oneshot service, not read by the server via the instance role, and no Bedrock (ADR-0010) |
| N10 | No size budget for policy channels; tool search defers descriptions | Adopted (modified) | POL §5 budgets (2,000/1,000/600/500/400; server instructions 2,000 with first 512 self-contained, based on the primary 4,096 cap); MCP §1 `ttlMs`; `alwaysLoad` M0 Q07; refresh note CLI §4.3 |
| N11 | Projection targets leak into git; collide with native memory | Adopted (modified) | CLI §5; ADR-0009. No projection files in v1 (optional user-level files deferred in round 3); the Cursor repo file holds policy text only and is git-excluded |
| N12 | Gemini cannot register under the DCR allow-list | Adopted (modified) | SEC §4.2–4.3: pairing window, static credentials for Gemini, exact redirects recorded in M0 Q10, `application_type` checked. IP allow-list dropped entirely (SEC §1.6) |
| N13 | PC↔server internal API unspecified | Adopted | MCP §7 (`/v1/session-start`, `/v1/projection`, `/v1/writes`, `/v1/recall`, `/v1/status`, `/v1/repos/check`, `/v1/admin/*`, `/v1/health`); 426 skew rule TOP §11 |
| N14 | No live-save idempotency; spool unspecified; offline outcome missing | Adopted | WP §2.3; DM `write_request`; TOP §9 (per-entry files, format, drain, replay), §5 offline table; `queued` outcome |
| N15 | Recurrence ill-defined; observation table incomplete | Adopted (modified) | POL §8; DM `observation`, `observation_mention`, `embedding.owner_type`; ADR-0008 (2 distinct sessions; chat session = client + 6 h gap) |
| N16 | Interface contracts missing | Adopted | MCP §2–4 (JSON Schemas, annotations, errors); RET §7.2 profile algorithm; contracts package committed first (D §7 M1) |
| N17 | SessionStart over the network blocks the first response | Adopted | CLI §3.1 (1.5 s network, 5 s hook timeout, offline cache); RET §8 precomputed context; EV §3.7 remote gates; AWS §11 region by RTT |
| N18 | Claude Code inherits the claude.ai connector (duplicate tools) | Adopted | CLI §3.2 "Duplicate connector"; M0 Q17; doctor check |
| N19 | Instance size, model fit and cost not pinned | Adopted (modified) | AWS §2 (t4g.small, swap), §10 cost table; ADR-0005 selection rule; RET §10. Unlimited credits rejected (ADR-0011, denial of wallet) |
| N20 | No backup retention numbers | Adopted (modified) | AWS §5.3; ADR-0012 (noncurrent 14 d; on-instance copies ≤ 48 h; backups ≤ 30 days); RPO/RTO AWS §5.3; store hash and content hash DM §12 |
| N21 | Named-pipe ACL impossible in plain Node | Adopted | TOP §4 (loopback + token + Host/Origin); ADR-0006 |
| N22 | `connect` cannot repoint chat apps; credentials issuer-bound | Adopted | TOP §7; hostname fixed before M2 (D §3, AWS §6) |
| N23 | Dynamic sections undefined and unbounded | Adopted (modified) | POL §9.2; ADR-0018 (auto-created per owner decision; cap 16, ≤ 2 per run; text not model-facing until approved) |
| N24 | Wrong capture hook; assistant text reaches extractor | Adopted | WP §10.1–10.2; ADR-0014; support ≥ 0.6 plus span ≥ 8 chars |
| N25 | `explicit_request` and topic-gated recall model-judged; Gemini PI | Adopted (modified) | POL §7.2 (claimed request → pending_review, ADR-0016; recall gated by client allow + query lexicon; render-time recheck); Gemini save floor CLI §2 |
| N26 | Server cannot know client policy version | Adopted | POL §12; MCP §3.3 `policy_version`; `client_policy.last_policy_version` |
| N27 | Gate statistics, isolation, Gemini path, adapter contract, ablation | Adopted | EV §1 (isolation), §4 (labelling), §5 (statistics), §3.3 (ablation), §8.1 (adapter), §8.2 (Gemini), §2 (layout incl. P and I) |
| N28 | `memory_forget` unbounded | Adopted (modified) | WP §9.1: 5 per client per **day** (R2S P9, stricter than 5/hour); protected memories need elicitation or review; Recent changes feed |
| N29 | Single-file binary with native addons not straightforward | Adopted (modified) | CFG §1; ADR-0006. Client npm package `memory-anywhere` is pure JS (owner's package name); server as release tarballs; no SEA in v1 |
| N30 | Observability, alerting, rate limits, upgrades, migrations | Adopted | OPS §1–8; AWS §7.3 updater |
| N31 | Project registration, repo identity, work repos | Adopted | POL §10 (registration at `mema enable`); TOP §8 (repo key, deny-list); restricted `project.repo` attribute |
| N32a | "No other numeric cut-offs" false | Adopted | WP §12 (calibrated vs named constants) |
| N32b | BitLocker vs EBS | Adopted | SEC §11 |
| N32c | Port 80 for renewal | Adopted | AWS §2 SG 443 only; §4 TLS-ALPN-01 |
| N32d | "Before M4" SSO | Adopted | D §9 step 2 (before M0) |
| N32e | Missing decisions (domain, region, LLM, instance, retention) | Adopted | D §3; AWS §6, §11; ADR-0007, ADR-0012 |
| N32f | Local + Funnel doubles test matrix | Adopted (round 3: cut to a README note) | TOP §1; ADR-0023 |
| N32g | Token budgets without tokenizer | Adopted | RET §1 (chars) |
| N32h | Chat apps never call `memory_profile` | Adopted | POL §6.11 custom instruction first line; §6.4 description |
| N32i | "Claude's apps pass server instructions" unverified | M0 | M0 Q05 |
| N32j | Positioning claim: server judges text only | Adopted | POL intro; D §5 |

## 2. R2A contradictions C1–C27

| Id | Contradiction | Status | Where |
| --- | --- | --- | --- |
| C1 | Local by default vs AWS from day one | Adopted | TOP §1; D §3 |
| C2 | PC daemon owns DB vs one store | Adopted | TOP §2 (no PC store) |
| C3 | Daemon renders projection files vs daemon in AWS | Adopted | TOP §6 (client pulls) |
| C4 | No dump/wipe vs admin CLI token | Adopted | SEC §6 |
| C5 | Tier from path vs model `user_words` | Adopted | ADR-0002; DM §7 |
| C6 | Preferences remembered vs instruction screen to review | Adopted | POL §3.2; ADR-0003 |
| C7 | Passing taste = observation vs "from now on" saved | Adopted | WP §5 rows D15 (preference) vs D17 (taste class) |
| C8 | Second vs third mention promotes | Adopted | ADR-0008 |
| C9 | No cut-offs vs many numbers | Adopted | WP §12; CFG §5 |
| C10 | `section_id` promised, missing | Adopted | DM `memory.section_id NOT NULL` |
| C11 | Cardinality on memory | Adopted | DM `attribute.cardinality` |
| C12 | Project table keyed by memory | Adopted | DM §3 `project_view` over entity |
| C13 | Corrections vs always closing `valid_to` | Adopted | DM §6 |
| C14 | Rule 6 listed last | Adopted | WP §8 rule 0 first |
| C15 | Gemini relies on DCR vs allow-list | Adopted | SEC §4.2 (static credentials; DCR only in window) |
| C16 | `connect` repoints every client vs issuer binding | Adopted | TOP §7 |
| C17 | "Your turns only" vs Stop + assistant text | Adopted | ADR-0014 |
| C18 | Duplicate tools in Claude Code unhandled | Adopted | CLI §3.2 |
| C19 | Local latency gate vs remote owner path | Adopted | EV §3.7 |
| C20 | age for Litestream; plaintext project export | Adopted | AWS §5.1 (SSE-KMS only); DM §10 (project export plaintext by design, no sensitive data) |
| C21 | BitLocker vs EBS | Adopted | SEC §11 |
| C22 | SSO before M4 vs M0 deploy | Adopted | D §9 |
| C23 | Suites list omits P | Adopted | EV §2–3 (W R P A X S C I) |
| C24 | `idempotentHint` vs repeats count as mentions | Adopted | WP §2.3 |
| C25 | Projection/spool for chat apps | Adopted | CLI §1 (standard path; enhancements only for coding tools) |
| C26 | Named pipe user-restricted vs default DACL | Adopted | ADR-0006 |
| C27 | Status reports a client's seen policy version | Adopted | POL §12 (reported, not observed) |

## 3. R2A missing specifications M1–M29

| Id | Missing spec | Status | Where |
| --- | --- | --- | --- |
| M1 | Owner topology | Adopted | TOP §1–3 |
| M2 | Server decision table; pending_review visibility | Adopted | WP §5; DM §5 |
| M3 | Preference vs instruction definitions | Adopted | POL §3.1–3.2 |
| M4 | PC credential scopes; admin step-up | Adopted (modified) | SEC §5.6, §6 (one PC grant) |
| M5 | Tier assignment table | Adopted (modified) | DM §7; WP §2.1; ADR-0002 |
| M6 | Version semantics; `expired_at` | Adopted | DM §6 |
| M7 | Historical facts; suppression; rule order | Adopted | WP §8–9 |
| M8 | Attribute registry; placement; project as entity | Adopted | DM §2–4; POL §9.1 |
| M9 | LLM adapter | Adopted | WP §6.2 |
| M10 | Channel budgets; `alwaysLoad`; `ttlMs` | Adopted | POL §5; MCP §1, §3 |
| M11 | Projection paths and git rules | Adopted (modified) | CLI §5 |
| M12 | OAuth allow-lists incl. Gemini, Codex, `application_type` | Adopted (modified) | SEC §4.2–4.3 (Codex via PC proxy, so no Codex CIMD entry) |
| M13 | Internal API | Adopted | MCP §7 |
| M14 | `write_request`, keys, spool, offline | Adopted | WP §2.3; TOP §5, §9 |
| M15 | Observation tables, session key, lifecycle | Adopted | DM §2; POL §8; WP §2.2 |
| M16 | Tool schemas, outputSchema, errors, profile algorithm | Adopted | MCP §2–4; RET §7 |
| M17 | Hook timeouts and remote latency gates | Adopted | CLI §3.1; EV §3.7 |
| M18 | Backup retention, RPO/RTO, store hash | Adopted | AWS §5; DM §12 |
| M19 | Operations | Adopted | OPS |
| M20 | Repo key and deny-list | Adopted | TOP §8 |
| M21 | Scope semantics | Adopted | RET §4 |
| M22 | Client policy store | Adopted | DM `client_policy`; CFG §5 `client_defaults` |
| M23 | Config file | Adopted (modified) | CFG §5–6 (`server.toml`, `client.toml`; server rejects unknown keys, client warns) |
| M24 | CLI surface | Adopted | CFG §4 |
| M25 | Admin UI v1 scope | Adopted | SEC §8.1 |
| M26 | Export format | Adopted | DM §10–11 |
| M27 | Native re-import | Adopted | IMP §4 |
| M28 | Per-milestone acceptance criteria and non-goals | Adopted | D §7 |
| M29 | Testing strategy | Adopted | OPS §9; WP §14 |

## 4. R2S claims checked (§3)

| Claim | R2S verdict | Status | Where |
| --- | --- | --- | --- |
| Gemini relies on DCR | Wrong | Adopted | SEC §4.2 (static credentials); M0 Q10 |
| Gemini shares Personal Intelligence data | Correct, broader | Adopted | CLI §2; SEC §1.5 |
| Gemini redirect URIs shared host | Shared | Adopted | SEC §4.3 (exact URI recorded at pairing) |
| Refresh rotation conflicts with Google guidance | Conflicts | Adopted | SEC §5.3 (`fixed` for Gemini confidential client) |
| ChatGPT callback is a pattern | Pattern | Adopted | SEC §4.2 (stable `connector_platform_oauth_redirect`; M0 Q03) |
| Vendor IP allow-list | Weak control | Adopted | SEC §1.6 (not used) |
| Claude CIMD, deadlines, invalid_grant | Correct | Adopted | SEC §4.7; M0 §5 |
| Project hooks need trusted workspace | Partly wrong | Adopted | CLI §3.1 (documented facts; user-level hooks only) |
| Codex `/hooks` trust | Correct | Adopted | CLI §3.3 |
| `autoMemoryDirectory` from any scope | Trap | Adopted | CLI §5 (never used) |
| Litestream `age` | Wrong | Adopted | AWS §5.1 |
| Litestream IAM | Needs scoping | Adopted | AWS §3.3 |
| Managed SSM policy `GetParameter *` | Incomplete | Adopted | AWS §3.3 |
| t4g unlimited by default | Trap | Adopted | ADR-0011 |
| IMDS not mentioned | Missing | Adopted | AWS §2, §4 |
| Named pipe DACL | Needs native | Adopted | ADR-0006 |
| Claude Code plaintext credential file | True for others | Adopted | SEC §5.6 (coding tools use the stdio proxy; no remote connector in their config) |
| "No postinstall" unachievable | Unachievable | Adopted | SEC §10 (client has none; server allow-list) |
| Better Auth CVEs | Selection risk | Adopted | ADR-0004; M0 Q15 (GHSA check) |
| MCP security best practices (consent) | Incomplete | Adopted | SEC §4.6, §8 |
| CIMD draft rules | Incomplete | Adopted | SEC §4.3 |
| RFC 9700 | Incomplete | Adopted | SEC §4.5 |
| Passkey recovery (FIDO) | Thin | Adopted | SEC §3.1, §3.3 |
| Vendors see recalls (omits Google) | Omits | Adopted | SEC §1.5 |

## 5. R2S attack paths

| Id | Path | Status | Where |
| --- | --- | --- | --- |
| P1 | Web page → Claude saves a "preference" | Adopted (modified) | WP §2.1 (T2), RET §7.1 (profile only T0/T1 preferences), POL §3.2; ADR-0003 instead of pending_review for all preferences |
| P2 | Other ChatGPT apps → silent saves | Adopted (modified) | Same as P1. Default ChatGPT `save_floor = observation` **rejected**, with the reason corrected in round 3: a T2 save cannot enter the always-loaded profile as a preference, cannot supersede T0/T1, and cannot replace a profile key fact written by another client (that becomes contested and shows as "unconfirmed: A / B", WP §8 rule 4a); so a floor would mostly block legitimate ChatGPT saves. The owner can still set a floor per client (DM `client_policy.save_floor`) |
| P3 | Gemini PI email → fake facts, third-party data | Adopted | CLI §2 (Gemini floor observation, narrowed sections); WP D3 (third-party sensitive rejected); D11 before D12 so Gemini never supersedes |
| P4 | Repo content → coding agent save | Adopted | MCP §6 (writes only in enabled repos), WP pre-checks |
| P5 | Capture role confusion; extractor steering | Adopted | ADR-0014; WP §10.1–10.2 |
| P6 | Imports of attacker/model-authored sources | Adopted | IMP §1–2 (user-level only; model-written → observation; T3 not in profile) |
| P7 | Spool tampering | Adopted | TOP §9; SEC §7; MCP §7 (no spooled forget) |
| P8 | Dynamic section and alias poisoning | Adopted (modified) | ADR-0018; DM `entity_alias.approved` |
| P9 | Supersede, contest and forget abuse | Adopted | WP §8.2 rights; §9.1 (5/day); OPS §2 `supersede_remote` digest |
| P10 | Recall-framing breakout | Adopted | WP §4 step 1; RET §9 |
| E1 | Chat injection → exfiltration via another tool | Adopted | RET §2 (abstention), §5 (budgets); ADR-0013 allow-lists |
| E2 | Slow drip below quotas | Adopted | RET §5 (chat 20/h, 60/24 h) |
| E3 | Section enumeration, wildcard | Adopted | RET §2 steps 1, 2 (time-only cap 5), 5.8 |
| E4 | Project catalog in profile | Adopted (modified) | RET §7 (no project names in profile); restricted attributes; ADR-0013 keeps Projects readable by Claude chat (owner uses Claude mobile for project questions) |
| E5 | SessionStart in untrusted repos | Adopted | RET §8 (enabled repos only) |
| E6 | Agent shell with CLI admin token | Adopted (modified) | SEC §6 (passkey step-up via admin UI). Windows Hello TPM key not adopted (ADR-0006) |
| E7 | Projection files leave the machine | Adopted | CLI §5; ADR-0009 |
| E8 | Status reconnaissance; `fetch` alias | Adopted | MCP §3.5 (orders of magnitude); the `search`/`fetch` aliases were removed in round 3 (MCP §1) |
| E9 | Vendor account takeover | Adopted (accepted risk) | SEC §1.5; one-click revoke §8.1 |
| O1 | Consent phishing via stranger's vendor account | Adopted | SEC §4.1, §4.6; ADR-0017 |
| O2 | Open DCR abuse | Adopted | SEC §4.3 |
| O3 | CIMD SSRF, prefix bypass | Adopted | SEC §4.3; AWS §4 iptables |
| O4 | Redirect tricks; loopback impersonation | Adopted | SEC §4.5; loopback only for the PC client |
| O5 | Silent re-grant, CSRF, clickjacking | Adopted | SEC §4.6 |
| O6 | Token theft on Windows | Adopted (modified) | Stdio proxy only (CLI §2); PC refresh 7 d idle / 30 d absolute (SEC §5.2). DPoP with TPM key rejected (ADR-0006: same-user malware can drive the proxy anyway; native code on every install) |
| O7 | Refresh replay; rotation conflicts | Adopted | SEC §5.3 |
| O8 | Bootstrap race; recovery | Adopted | SEC §3.1, §3.3 (setup token via SSM; two passkeys, different provider or device-bound; argon2id codes; break-glass) |
| O9 | Auth-library flaws; default routes | Adopted | SEC §5.1 (route inventory), §10 (72 h) |
| O10 | Cookie-authenticated `/mcp` | Adopted | SEC §5.5 |
| A1 | Stored XSS | Adopted | SEC §8 |
| A2 | CSRF | Adopted | SEC §8 |
| A3 | Clickjacking | Adopted | SEC §8 |
| A4 | Markdown/HTML injection in projections | Adopted | RET §9; CLI §5 |
| A5 | Session scope and step-up | Adopted | SEC §3.4 |
| H1 | Repo hook config calls the CLI | Adopted | SEC §6 (no standing admin); PC grant repo-limited; CLI §6 `foreign-hooks` check |
| H2 | `.mcp.json` shadowing | Adopted | CLI §3.2 (doctor, `disabledMcpjsonServers` per M0 Q17) |
| H3 | Fake managed blocks | Adopted | CLI §5 (body hash; never parsed) |
| H4 | Project-level `autoMemoryDirectory` | Moot | CLI §5 (never used) |
| H5 | Eval harness under `-p` | Adopted | EV §8.3 |
| H6 | Plugin update compromise | Adopted | SEC §10 |
| H7 | Named-pipe squatting | Moot | ADR-0006 (no named pipes) |
| S1 | Compromised release | Adopted | SEC §10 |
| S2 | Dependency install scripts | Adopted | SEC §10; CFG §2 |
| S3 | Model swap on Hugging Face | Adopted (modified) | RET §10 (revision + per-file SHA-256, verified at load). Shipping the model inside the release artifact rejected: EmbeddingGemma's Gemma terms may not allow redistribution; downloaded at init with hash check |
| S4 | Auth library | Adopted | see O9 |
| S5 | Caddy plugins, admin API | Adopted | AWS §4 (`admin off`, no plugins) |
| W1 | SSRF → IMDS | Adopted (modified) | AWS §2, §4. iptables blocks the server and Caddy users rather than allowing only Litestream, because the SSM and CloudWatch agents also need IMDS |
| W2 | SG, egress, local listeners | Adopted | AWS §2, §4 (unix socket, XFF replaced) |
| W3 | Bucket exposure and tampering | Adopted (modified) | AWS §5.2 (noncurrent expiry 14 d per ADR-0012) |
| W4 | KMS key policy | Adopted | AWS §3.4; alarms §2 |
| W5 | Litestream credentials | Adopted (modified) | AWS §5.1, §3.3. Litestream gets read-write (not read-only) access to the DB directory, because it performs the WAL checkpoints with `wal_autocheckpoint=0` |
| W6 | SSM and Claude Code AWS profile | Adopted | AWS §3.1–3.3 |
| W7 | CDK bootstrap admin | Adopted | AWS §3.1 |
| W8 | Dangling DNS, CT recon | Adopted (modified, round 3) | AWS §6 (retained Elastic IP; teardown releases the IP only after the Cloudflare records stop resolving; CAA on the subdomain, accounturi optional); ADR-0024. The hostname is public via CT and not treated as a secret, so the non-identifying-label advice was dropped. Wildcard certificate via DNS-01 not chosen: it needs DNS write credentials on the instance |
| W9 | Account root | Adopted | AWS §3.1, §2 CloudTrail |
| D1 | CPU flood, unlimited credits | Adopted | ADR-0011; OPS §3 |
| D2 | Paid LLM calls | Adopted | WP §6.2 caps |
| D3 | Client, observation, log growth | Adopted | SEC §4.3 (≤ 20 clients); POL §8 (500 per client); OPS §1 sampled logs |
| D4 | Data-transfer flood | Adopted | MCP §1 response caps; Budgets |
| B1 | Tampered backup | Adopted | DM `event` hash chain; AWS §5.4–5.5 |
| B2 | Restore brings back revoked tokens | Adopted (modified) | AWS §5.5: always rotate secrets and sessions; grants revoked on `--reason compromise` or old restore points, kept on `--reason lost` within 1 h (re-pairing every app after a disk failure is a large cost for a small window) |
| B3 | age identity custody | Adopted | DM §10; SEC §11 |
| B4 | Litestream age | Adopted | AWS §5.1 |
| X1 | Purge leaves copies | Adopted | DM §9 |
| X2 | Backups keep purged data | Adopted (modified) | AWS §5.3; ADR-0012 (30 days, not 37) |
| X3 | Re-learning purged facts | Adopted | WP §9.2 |
| X4 | Old exports | Adopted | DM §10 (suppressions applied first); SEC §8.1 (issued exports list) |

## 6. R2S privacy analysis (§5)

| Item | Status | Where |
| --- | --- | --- |
| Sensitive classifier: two checks, render-time recheck, per-category n and CI, People high-risk | Adopted (modified) | POL §7.2–7.3 (lexicon + optional LLM flag; render-time recheck; third-party sensitive always rejected; per-category reporting needs n ≥ 300 for claims). Flagged items follow rows D3–D6 rather than all going to pending_review |
| `explicit_request` / `user_words` spoofing | Adopted | ADR-0016; MCP §3.3 (`user_words` ≤ 200); POL §7.2 rule 9 |
| Retention numbers | Adopted (modified) | CFG §5 `[retention]`; AWS §5.3 (S3 noncurrent 14 d instead of 30) |
| Audit-log privacy (HMAC, /24, no UA) | Adopted | DM `audit`; OPS §4 `hmac_rotate` |
| What vendors see | Adopted | SEC §1.5 |
| Third-party data via Gemini | Adopted | SEC §1.5; WP D3 |

## 7. R2S doc changes D-0..D-18

| Id | Change | Status | Where |
| --- | --- | --- | --- |
| D-0 | Gemini row; exact redirects | Adopted | CLI §2; SEC §4.2–4.3 |
| D-1 | Tier table; model fields never raise tier; preference gated | Adopted (modified) | ADR-0002 (adopted); preference gating modified by ADR-0003 |
| D-2 | Profile: T0 preferences, T0/T1 facts, names only | Adopted (modified) | RET §7.1: preferences T0/T1; key facts from a fixed attribute list may be T2 (ADR-0003 explains why) |
| D-3 | Sensitive: hint only, pending_review, third-party rejected, render-time check, n ≥ 300 | Adopted | POL §7.2; ADR-0016 |
| D-4 | Sections proposed until approved | Adopted (modified) | ADR-0018 (owner decision: created automatically; only the name is model-facing before approval) |
| D-5 | Prompts only; grounded spans; untrusted spool; opt-in covers injection | Adopted | ADR-0014; TOP §9; RET §8 |
| D-6 | Escaping and framing | Adopted | RET §9 |
| D-7 | Read budgets; no standing admin; DPoP | Adopted (modified) | RET §5; SEC §6. DPoP/TPM rejected (ADR-0006) |
| D-8 | Pairing, registration, redirects, consent, grants, tokens, bootstrap | Adopted | SEC §3–5 |
| D-9 | Web surfaces | Adopted | SEC §8 |
| D-10 | Projections user-level only | Adopted (modified) | CLI §5 (off by default; Codex `memories_extensions` not used, undocumented per R2F row 40) |
| D-11 | Threat rows; vendors incl. Google | Adopted | SEC §1.4–1.5 |
| D-12 | Purge scope; README statement; retention | Adopted (modified) | DM §9; AWS §5.3 (30 days) |
| D-13 | AWS stack | Adopted | AWS §2–6 |
| D-14 | Supply chain row | Adopted | SEC §10 |
| D-15 | Named pipe with explicit DACL and handshake | Rejected | ADR-0006: no PC store; local mode uses loopback + token |
| D-16 | Hook-trust facts; eval flags | Adopted | CLI §3.1; EV §8.3 |
| D-17 | M0 separate stack; M2 S cases | Adopted | M0 §2; AWS §9; EV §3.5, §10 |
| D-18 | Deploy profile handoff | Adopted | D §9; AWS §3.2 |

## 8. R2S top-10 residual risks and open items

| Item | Status | Where |
| --- | --- | --- |
| Risk 1 consent phishing, enrollment race | Adopted | SEC §3.1, §4 |
| Risk 2 agent shell bypass | Adopted | SEC §6; AWS §3 |
| Risk 3 model-asserted tiers, preference kind | Adopted | ADR-0002, ADR-0003 |
| Risk 4 projection files | Adopted | ADR-0009 |
| Risk 5 XSS/CSRF/clickjacking | Adopted | SEC §8 |
| Risk 6 slow-drip exfiltration | Adopted | RET §5 |
| Risk 7 AWS credential chain | Adopted | AWS §2–4, §6; ADR-0010 |
| Risk 8 deletion guarantee | Adopted | DM §9; AWS §5.3 |
| Risk 9 capture/import poisoning | Adopted | ADR-0014; IMP §1 |
| Risk 10 auth library, plugin supply chain | Adopted | SEC §5.1, §10 |
| Open 1 Gemini manual credential fields | M0 | Q10 |
| Open 2 Claude CIMD URL; ChatGPT callback/CIMD | M0 | Q04, Q03 |
| Open 3 Elicitation to the human | M0 | Q09 |
| Open 4 Native helper (pipe DACL, TPM DPoP) | Rejected | ADR-0006 |
| Open 5 `--strict-mcp-config`; plugin `permissions.deny` | M0 | Q12, Q13 |
| Open 6 Where Codex and Cursor store remote MCP tokens | Moot | Coding tools reach the store only through the stdio proxy (CLI §2) |
| Open 7 Auth library choice | M0 | Q15; ADR-0004 |

## 9. R2F claims rows (non-"Correct" verdicts, and "Correct, with caveats" rows that change the design)

| Row | Topic | Verdict | Status | Where |
| --- | --- | --- | --- | --- |
| 6 | Gemini context injection | Unverified | M0 | Q05, Q19 |
| 7 | Claude's apps pass server instructions | Unverified | M0 | Q05; budgets use the primary 4,096 Claude Code cap |
| 8 | Which clients pass instructions | Partly settled | M0 | Q05; POL §5 table lists documented ones |
| 9 | `server/discover` carries instructions; serverInfo in `_meta` | Correct, more detail | Adopted | MCP §1 |
| 10 | Description truncation; tool search | Partly | Adopted | POL §5 (trigger in first 200 chars); M0 Q06, Q07 |
| 11 | structuredContent vs text | Partly | Adopted | RET §6; MCP §3 (framing in both) |
| 12 | MCP Apps widget batching | Partly/Unverified | Moot | Out of scope v1 (D §1) |
| 13 | claude.ai skill install | Partly | Adopted | CFG §4.1 `--claude-ai-skill`; POL §6.10 frontmatter limited |
| 15 | Cursor also loads skills from `.claude/skills`, `.codex/skills`, `.agents/skills` | Correct, plus | Adopted | CLI §3.3 (one standalone skill), §6 `skill.single` |
| 16 | Claude tool access per conversation | Partly | Adopted | CLI §4.1; M0 Q08 |
| 18 | ChatGPT memory with dev mode | Unverified | M0 | Q02 |
| 20 | Better Auth details (JWT, no recovery codes, email) | Correct, caveats | Adopted | ADR-0004 |
| 21 | node-oidc-provider CIMD experimental | Correct | Adopted | ADR-0004 (`~` pin) |
| 24 | Named pipe | At risk | Adopted | ADR-0006 |
| 25 | onnxruntime-node size, no darwin x64, postinstall | Caveats | Adopted | CFG §1–2 |
| 26 | transformers.js pins second ORT | Partly | Adopted | RET §10 (not used) |
| 27 | EmbeddingGemma caveats | Caveats | Adopted | RET §10; ADR-0005 |
| 29 | Litestream defaults, WAL settings, no age, no Windows | Plus | Adopted | DM §1 PRAGMAs; AWS §5.1; local mode has no Litestream |
| 30 | age vs KMS | Partly | Adopted | SEC §11 |
| 31 | Caddy port 80; domain required | Partly | Adopted | AWS §2, §6 |
| 32 | t4g free period ends Dec 31 2026 | Correct | Adopted | AWS §10 |
| 36 | Claude Code plugin structure | Correct | Adopted | CLI §3.2 (no `bin/`, validate --strict, name without `claude-`) |
| 37 | Codex plugins exist | Outdated | Adopted | CLI §3.3 |
| 38 | Cursor plugins exist | Outdated | Adopted | CLI §3.4; M0 Q13 |
| 39 | `autoMemoryDirectory` relocates memory | Partly/risky | Adopted | CLI §5 |
| 40 | Codex `memories_extensions` | Unverified | Rejected (not used) | ADR-0009 |
| 41 | Codex context cap 2,500 tokens; SessionEnd 1 s | Partly | Adopted | POL §5 (6,000 chars); no SessionEnd hook used |
| 42 | Cursor `beforeSubmitPrompt`; Windows `.ps1` rule; `version: 1` | Partly | Adopted | CLI §3.4 |
| 43 | Cursor CLI MCP; hooks undocumented | Partly settled | Adopted | EV §8.3 |
| 44 | `claude -p` details | Correct, plus | Adopted | EV §8.3 |
| 45 | Claude Code imports claude.ai connectors | Missing fact | Adopted | CLI §3.2 |
| 46 | Claude desktop duplicate tools | Unverified | Adopted | CLI §2 (init never writes desktop stdio config) |
| 47 | Annotation defaults | Partly | Adopted | MCP §3.3 |
| 51 | DCR redirect list incomplete | Incomplete | Adopted | SEC §4.2–4.3; Cursor web via "Other" (CLI §2) |
| 52 | `iss` not on Claude page | Correct, partly | Adopted | SEC §4.5 (justified by ChatGPT stable redirect) |
| 53 | Claude app limits | Missing fact | Adopted | MCP §1 timeouts row |
| 54 | mcp-memory-service version | Outdated | Adopted | D §2 (12.7.0) |
| 55 | arXiv 2608.19564 title and figure | Partly | Adopted | POL intro |
| 56 | HaluMem "< 50%" from authors' comment | Partly | Adopted | Not repeated as a headline claim; EV §1 cites HaluMem only for per-operation scoring |
| 57 | mem0 read-time conflict resolution unconfirmed | Partly | Adopted | D §2 (claims only add-only) |
| 60 | "Node LTS" underspecified | Underspecified | Adopted | CFG §2 |
| 61 | SessionStart overflow; UserPromptSubmit stdout becomes context | Plus | Adopted | CLI §3.2 (prompt hook prints nothing; ≤ 9,000) |
| 62 | Exec form needs real executable | Correct | Adopted | CLI §3.1 |
| 49 | Tailscale Funnel is beta; ports 443/8443/10000 | Correct | Moot (round 3) | Tunnel mode cut to a README note (TOP §1, ADR-0023) |

## 10. R2F section B facts (1–18)

| # | Fact | Status | Where |
| --- | --- | --- | --- |
| B1 | Descriptions deferred; 4,096 cap | Adopted (modified) | POL §5 (tighter budgets than the proposed 4,000, to leave room for unknown clients; M0 Q06 measures) |
| B2 | Instructions reach Claude Code, ChatGPT, Codex | Adopted | POL §5; M0 Q05 |
| B3 | Annotation defaults | Adopted | MCP §3 |
| B4 | Redirect lists lock out Gemini and Cursor web | Adopted | SEC §4 |
| B5 | Better Auth JWTs etc. | Adopted | ADR-0004 |
| B6 | Pipe cannot be restricted; use token | Adopted | TOP §4 |
| B7 | Capture can skip transcripts | Adopted | ADR-0014 |
| B8 | Hook time budgets | Adopted | CLI §3.1; POL §5 |
| B9 | Don't use `autoMemoryDirectory` | Adopted | CLI §5 |
| B10 | Duplicate servers in Claude Code | Adopted | CLI §3.2 |
| B11 | Litestream age, retention, `wal_autocheckpoint=0` | Adopted | AWS §5.1; DM §1 |
| B12 | ORT + tokenizers; onlyBuiltDependencies; defer SEA | Adopted | CFG §1–2; RET §10 |
| B13 | EmbeddingGemma q8/q4, prefixes, licence, RSS | Adopted | RET §10; M0 Q14 |
| B14 | Free tier ends; domain required | Adopted | AWS §6, §10 |
| B15 | Codex and Cursor plugins | Adopted | CLI §3.3–3.4 |
| B16 | One skill appears several times | Adopted | CLI §3.3 (one standalone skill), §6 `skill.single` |
| B17 | Gemini prompts every write; forwards data | Adopted | CLI §2, §4.2 |
| B18 | API suites differ from apps; eval tokens | Adopted | EV §8.2 |

## 11. R2F buildability gaps

| Id | Gap | Status | Where |
| --- | --- | --- | --- |
| C0.1 | Doc inconsistencies (Gemini in summary, SSO, P suite, cut-offs, observation rule, instruction boundary, token format) | Adopted | D §1, §9; EV §2; WP §12; ADR-0008; POL §3.2; ADR-0004 |
| C0.2 | Toolchain | Adopted (modified) | CFG §2. `@napi-rs/keyring` rejected (client has no natives, ADR-0006); package names per owner decision (`memory-anywhere`, workspace `@memory-anywhere/*`) |
| C0.3 | Paths | Adopted (modified) | CFG §3 (no pipe; `client.toml`/`server.toml`; `MA_HOME`) |
| C0.4 | ID and time formats | Adopted | DM §1 |
| M0.1 | What M0 builds | Adopted | M0 §1 |
| M0.2 | Spike questions S1–S13 | Adopted | M0 §4 (as Q01–Q24, each with fallback) |
| M0.3 | Canary convention | Adopted (modified) | M0 §3 (canaries at 1,900, 3,900, 4,300 to test the 2,000 budget too) |
| M0.4 | Seed retrieval set | Adopted | EV §3.2 |
| M0.5 | Embedding candidates and rule | Adopted | ADR-0005 |
| M0.6 | AWS spike stack | Adopted (modified) | AWS §9 (same hardened app, not the managed SSM policy; 443 only) |
| M0.7 | Harness skeleton, CIs, paired bootstrap | Adopted (modified) | EV §5 (10,000 resamples, per R2A N27, instead of 2,000) |
| M0.8 | ADR and negative-results format | Adopted | decisions/ADR-template.md; M0 §6 |
| M0.9 | CI matrix | Adopted | OPS §10 |
| M1.1 | Process model (daemon on pipe) | Adopted (modified) | TOP §4–5: no PC daemon; local mode loopback + token; proxy relays to remote `/mcp` |
| M1.2 | Config schema | Adopted (modified) | CFG §5–6 (calibrated thresholds in `meta`; LLM config server-side) |
| M1.3 | Schema DDL decisions | Adopted (modified) | DM §2 (FTS maintained by application code in the write transaction, not triggers; repo scopes use hashed repo keys; cardinality on attribute) |
| M1.4 | Tool contracts | Adopted (modified) | MCP §3 (`content` ≤ 400, `user_words` ≤ 200, default limit 6, tier as `T0`–`T3`, `attribute` hint adopted, `change` and `expires_on` added) |
| M1.5 | Policy file and generated channels | Adopted (modified) | POL §4–6 (tighter budgets, see B1) |
| M1.6 | Rules pipeline order | Adopted (modified) | WP §5 (short-lived rejected; sensitive with claimed request → review; quota as pre-check error) |
| M1.7 | Write path details | Adopted (modified) | DM §1 norm; WP §2.3, §6.1, §11–13. Tier rule replaced by ADR-0002 |
| M1.8 | Retrieval details | Adopted (modified) | RET §2 (abstention by calibrated cosine instead of the fixed RRF floor) |
| M1.9 | Sections and observations | Adopted (modified) | POL §8–9. Promotion "2 sessions OR 3 mentions" rejected (ADR-0008). Automatic dynamic sections stay in M1 (owner decision) with TF-IDF names when no LLM |
| M1.10 | Projections on commit to user rules/AGENTS/Cursor | Adopted (modified) | ADR-0009: pulled by the client; off by default |
| M1.11 | Instruction vs preference | Adopted (modified) | POL §3.2; ADR-0003 |
| M1.12 | Spool as per-client daily JSONL append | Rejected | TOP §9 uses one file per entry with atomic rename (concurrent writers on Windows; per-entry deletion), per R2A N14 |
| M1.13 | Hooks incl. Stop recording | Adopted (modified) | CLI §3 (no Stop hook; prompt-only capture); M1 capture uses no-LLM mode (WP §10.3), LLM extraction in M3 |
| M1.14 | CLI surface (save/list as plain commands) | Adopted (modified) | CFG §4 (save, list, show, forget, export, import are step-up admin commands; `search` is the client read) |
| M1.15 | Plugins and bundling | Adopted (modified) | CLI §3 (bundle is pure JS; no native modules needed on the PC) |
| M1.16 | Fixtures and gates | Adopted (modified) | EV §3.1 (gate on Wilson upper bound ≤ 2% on ≥ 300 items, per R2A N27, instead of point rate ≤ 1%) |
| M1 done | M1 definition of done | Adopted | D §7 |

## 12. First-round Critical/High findings (R1A) and carried fact-check items

| Id | Sev | Finding | Status in v3 | Where |
| --- | --- | --- | --- | --- |
| A1 | Critical | One store, projections, spool | Resolved | TOP §1–9 |
| A2 | High | SQLite everywhere | Resolved | DM §1; AWS §1 |
| A3 | High | Vectors as BLOBs | Resolved | DM `embedding`; RET §2 |
| A4 | High | One pinned embedding model | Resolved | RET §10; ADR-0005 |
| A5 | Critical | Deterministic merge with slots | Resolved | DM `attribute`; WP §8 |
| A6 | High | Contested stays visible | Resolved | WP §8; RET §2 step 9 |
| A7 | High | Bitemporal fields | Resolved | DM §6 |
| A8 | High | Entity, multi-source, scopes | Resolved | DM §2; RET §4 |
| A9 | High | Content-independent idempotency | Resolved | WP §2.3 |
| A10 | High | One writer, BEGIN IMMEDIATE | Resolved | WP §11; TOP §2 (single server process) |
| A11 | High | Delete vs append-only; tombstones | Resolved | DM §9; AWS §5.3 |
| S1 | Critical | Threat model | Resolved | SEC §1 |
| S2 | Critical | Redact before LLM/spool | Resolved | WP §3 |
| S3 | Critical | Trust tiers by path | Resolved | ADR-0002 |
| S4 | High | Instruction kind vs owner preferences | Resolved | POL §3; ADR-0003 |
| S5 | High | Exfiltration via list/recall | Resolved | MCP §3 (no list tool); RET §5; SEC §6 |
| S6 | High | Employer data | Resolved (modified) | Personal accounts only; capture and injection opt-in per repo; deny-list (TOP §8). A `work` scope rejected: employer data is out of scope, not stored separately |
| S7 | High | Library OAuth | Resolved | ADR-0004 |
| S8 | High | Claude/ChatGPT OAuth conformance | Resolved | M0 §5 |
| X1 | High | Projections | Resolved (modified) | ADR-0009 |
| X2 | High | Hook mechanics | Resolved | CLI §3 |
| X3 | High | Five tools | Resolved | MCP §3 |
| X4 | High | Policy in tool description | Resolved | POL §5–6 |
| U1 | Critical | ChatGPT feasibility | Resolved | M0 Q01; CLI §2 |
| U2 | High | Admin UI from M2 | Resolved | SEC §8.1 |
| U3 | High | Server down | Resolved | TOP §5; CLI §3.1 |
| D1 | High | Plugins | Resolved | CLI §3 |
| D2 | High | Windows hooks | Resolved | CLI §3.1; OPS §9 |
| D3 | High | AWS stack | Resolved | AWS |
| E1 | Critical | Eval rigor | Resolved | EV §1, §5 |
| E2 | High | Baselines | Resolved | EV §7 |
| E3 | High | API proxies for chat apps | Resolved | EV §8.2 |
| P1 | Critical | Security with first exposure | Resolved | D §7 M2 |
| P2 | High | Spike first | Resolved | M0 |
| P3 | High | Honest positioning | Resolved | D §2 |
| R1A Q1–Q11 | — | Owner questions | Answered by owner decisions | D §3 |
| R1F carried | — | Issuer-bound credentials (2026-07-28) | Resolved | TOP §7 |
| R1F carried | — | DCR `application_type` | Resolved | SEC §4.3 |
| R1F facts 1–2 | — | `server/discover`, `resultType`, `ttlMs`; no sessions needed | Resolved | MCP §1 (SDK `createMcpHandler`, legacy stateless) |
| R1F fact 3 | — | SDK has no AS | Resolved | ADR-0004 |
| R1F fact 4 | — | Claude OAuth details | Resolved | SEC §4.7; M0 §5 |
| R1F facts 5–7 | — | Aurora resume, HTTP API 30 s, VPC costs | Resolved | AWS §1 |
| R1F fact 8 | — | Secure MCP Tunnel | M0 | Q24 (informational) |
| R1F fact 9 | — | ChatGPT web only | Resolved | CLI §2 |
| R1F fact 10 | — | Hook trust and timing | Resolved | CLI §3.1 |
| R1F fact 11 | — | Vendor `/import` tools duplicate facts | Resolved | IMP §4 |
| R1F fact 12 | — | Codex memories unstable | Resolved | IMP §2 (observation only) |
| R1F fact 13 | — | Context caps | Resolved | POL §5 |
| R1F fact 14 | — | Claude Code eval harness flags | Resolved | EV §8.3 |
| R1F fact 15 | — | Quick Tunnels lack SSE | Moot (round 3) | No tunnel mode in v1 (TOP §1) |
| R1F fact 16 | — | Origin validation on local HTTP | Resolved | TOP §4; MCP §1 |

## 13. Summary of rejections and deviations

| Proposal | Source | Decision | Reason |
| --- | --- | --- | --- |
| T1v/T1c tiers from prompt-log substring | R2A N5 | Rejected | A prompt may contain pasted third-party text (ADR-0002) |
| Named-pipe native helper, TPM-bound DPoP, Credential Manager | R2S D-15, O6, E6; R2A N4; R2F C0.2 | Rejected | No PC store; same-user malware can drive the proxy; native code on every install (ADR-0006) |
| Preferences pending_review until approved | R2S D-1 | Modified | Recalled at once, profile only when confirmed (ADR-0003) |
| Nothing at T2 in the profile | R2S D-2 | Modified | Fixed-list key facts at T2 allowed (ADR-0003) |
| Dynamic sections only as proposals | R2S D-4 | Modified | Owner decided automatic creation; only the name is model-facing before approval (ADR-0018) |
| Projects readable only by coding tools | R2S E4 | Modified | Claude chat keeps project context; restricted fields CLI-only (ADR-0013) |
| ChatGPT saves floored to observation | R2S P2 | Rejected | A T2 save cannot enter the profile as a preference, supersede T0/T1, or replace another client's profile key fact (it becomes contested); the owner can set a floor per client |
| Unlimited CPU credits | R2A N19 | Rejected | Denial of wallet (ADR-0011) |
| Retention 7 d noncurrent (R2A) or 30 d (R2S) | R2A N20, R2S X2 | Modified | 14 d; 30-day guarantee (ADR-0012) |
| Vendor IP allow-list (with Google ranges) | R2A N12, R1A S12 | Rejected | Weak control; no Gemini list (SEC §1.6) |
| Server reads LLM key with instance role; Bedrock | R2A N9 | Rejected | No AWS credentials in the server process (ADR-0010) |
| User-level projections on by default; Codex `memories_extensions` | R2A N11, R2S D-10 | Modified / Rejected | Off by default; `memories_extensions` undocumented (ADR-0009) |
| Forget quota 5/hour | R2A N28 | Modified | 5/day (R2S P9) |
| Revoke all grants on every restore | R2S B2 | Modified | Kept for `--reason lost` within 1 h |
| Ship the model inside the release | R2S S3 | Modified | Download with per-file hash check (licence) |
| Wildcard certificate via DNS-01 | R2S W8 | Rejected | Needs DNS write credentials on the instance |
| Promotion at 2 sessions OR 3 mentions; dynamic sections moved to M3 | R2F M1.9 | Rejected | ADR-0008; owner decision on dynamic sections |
| Short-lived wording → observation | R2F M1.6 | Rejected | Rejected with a hint; observations would accumulate task details |
| Spool as daily JSONL append | R2F M1.12 | Rejected | Per-entry files (R2A N14) |
| Stop-hook assistant-message hash | R2F M1.13 | Rejected | Prompt-only capture (ADR-0014) |
| A `work` scope | R1A S6 | Rejected | Employer data out of scope by owner decision |

## 14. Round-3 audit (R3) and owner directives

### 14.1 Blockers

| Id | Finding | Status | Where |
| --- | --- | --- | --- |
| B1 | Domain needed in M0, not M2 | Adopted (then superseded by the Cloudflare directive, §14.9) | `MA_DOMAIN` is a required M0 input; D §3, §9.1; AWS §6.1; CFG §7; M0 §1; TOP §7 |
| B2 | AWS bootstrap has no actor, permissions or policy text | Adopted | AWS §3.3 (one-time bootstrap in CloudShell with a temporary admin assignment, removed afterwards; committed `deploy/aws/iam/*.json` reviewed by the owner; services listed; no Lambda, buckets emptied by `mema destroy`) |
| B3 | Deploy/operator split and "1-hour session" not real | Adopted (modified) | AWS §3.1–§3.4; ADR-0020. Two Identity Center users with separate MFA; operator only in AWS CloudShell, never on the PC; exact `~/.aws/config`; `mema deploy` signs out on exit; 1-hour portal session; `reset-owner` 24-hour delay with email and passkey cancel (SEC §3.3); sentences corrected (AWS §3.1, SEC §1.4, §1.5); M0 Q25 must pass. The audit's separate-OS-account option was not chosen: CloudShell is simpler for one person |
| B4 | M0 eval dataset needs non-Claude keys, no budget | Adopted | EV §1 rule 7, §3.2, §4; CFG §7 (`MA_EVAL_*`, `MA_EVAL_USD_CAP` ≤ $30); ADR-0022. M0 uses a public LongMemEval-S subset; seed-r moves to M1 |
| B5 | Release signing undefined | Adopted | AWS §7.4; ADR-0021 (owner release key before M2 in a GitHub environment secret; dev key for spike and eval; `--release-file`) |

### 14.2 Should-fixes

| Id | Finding | Status | Where |
| --- | --- | --- | --- |
| SF1 | Litestream YAML in deprecated shape | Adopted | AWS §5.1 (single `replica:`, top-level `snapshot:`, staging dir named) |
| SF2 | Bucket policy blocks stack updates | Adopted | AWS §5.2 (CFN exec role exempt; calls alerted, AWS §2) |
| SF3 | KMS key policy misses EBS and DLM | Adopted | AWS §3.6; DLM role in AWS §2 |
| SF4 | Operator set inherits deploy's denies | Adopted | AWS §3.4 (sets defined separately) |
| SF5 | Claude should default to static credentials | Adopted | SEC §4.2; CLI §2; M0 Q04; ADR-0017. CIMD kept for Claude Code direct HTTP (SEC §4.2–4.3) |
| SF6 | ChatGPT on the phone | Adopted (owner default) | D §1, §3; CLI §2; M0 Q01; EV §3.6; ADR-0019 (known-limitation fallback with re-test triggers) |
| SF7 | oidc-provider discovery routes | Adopted | SEC §2, §4.7; ADR-0004; M0 §5 test 17 |
| SF8 | T0 save matches no row | Adopted | WP §5 row D10a and T0 rule; `promotion` and `review_approve` enter at store rules (WP §2.1) |
| SF9 | Promotion reads unstored mention data | Adopted | DM `observation_mention` (`content`, `trust_tier`, `session_key`); DM §9 step 6; WP §8.3 |
| SF10 | Entity and attribute resolution circular | Adopted | WP §6.1 (ordered steps) |
| SF11 | Date-based idempotency key | Adopted | WP §2.3 (6-hour bucket and argument fields; `input_required` never stored) |
| SF12 | Elicitation must use MRTR `requestState`; questions must show content | Adopted | MCP §5; WP §5 (D5, D7, D15), §9.1; DM `pending_elicitation`, `meta.mrtr_key`; M0 Q09, §5 test 20 |
| SF13 | Gates impossible on the store hash | Adopted | DM §12 content hash; WP §14; IMP §6; EV §3 (I); OPS §6, §9 |
| SF14 | FTS tokenization mismatch | Adopted | DM `memory_fts` (`porter unicode61`); RET §2 step 3 |
| SF15 | `project_view` scalar and contested loss | Adopted (modified) | DM §3 (`project_field` view with JSON arrays and a contested flag), DM §11 (`contested_fields`) |
| SF16 | Project catalog pollution and fragmentation | Adopted | DM `entity.approved`; WP §6.1 (`project_proposal`, `norm_entity` folding); POL §10; CFG §4.2 `mema project add`; DM §11 approved-only export (owner directive) |
| SF17 | No way to confirm preferences | Adopted | WP §5 D15, §10.4; DM review kind `preference_confirm`, `change_kind = confirmation`, DM §5.1, §6; CFG §4.2 `mema review --approve`; ADR-0003 |
| SF18 | Three texts lack `policy P1` | Adopted | POL §6.2, §6.11, §6.12 (all twelve texts checked: within budget and carrying the marker) |
| SF19 | Events bypass relevance filtering | Adopted | WP §5 D13/D13b; 90-day clamp (CFG `event_max_ttl_days`); POL §3.6 lexicon additions with the two-way test |
| SF20 | T2 saves silently replace profile key facts | Adopted | WP §8 rule 4a, §8.2; RET §7.2 ("unconfirmed: A / B"); DM `memory_version.client_id`; ADR-0003; P2 reason rewritten (§5 and §13 above) |
| SF21 | Approved sensitive memory never recalled | Adopted | POL §7.2 rule 7; SEC §8.1 |
| SF22 | Two import session keys | Adopted | WP §2.2 |
| SF23 | T3 over T3 | Adopted | WP §8.2 (update); IMP §4 corrected |
| SF24 | `cacheScope` value | Adopted | MCP §1 (`"private"`) |
| SF25 | Local mode cannot be installed in M1 | Adopted | CFG §4.1 `--from-workspace`; D §7 M1 |
| SF26 | Step-up approval shows attacker text | Adopted (modified per owner directive) | SEC §6.2 (server-rendered text from parsed args; token bound to args digest; export shows recipient fingerprint; an unregistered recipient needs a typed fingerprint suffix and a second passkey assertion); MCP §7 (no `summary`); DM `stepup_request`, `export_recipient`; DM §10. `--recipient` is kept for unregistered keys behind the second confirmation instead of being removed; `client.toml export.age_recipients` removed. `mema save` no longer exists in the CLI (OE8), which closes the T0-instruction path |
| SF27 | `X-MA-Origin` passes through on `{host}` | Adopted | AWS §4 Caddyfile; SEC §2; EV S-WEB-05 |
| SF28 | Purge guarantee holes | Adopted | DM §1, §9 (copies table, no TRUNCATE under Litestream, `ma-maint`); AWS §4, §5.3, §7.3 (24-hour deletion of pre-copies); OPS §6; EV S-PURGE scans every file; SEC §1.4 corrected (30 days, 48 hours on the instance) |
| SF29 | Pairing window observable and not bound to owner | Adopted | SEC §4.1 (identical responses, `__Host-ma_pair` cookie or pair code, race closes window), §4.6; DM `pairing_window`; OPS alert `pairing_race`; M0 §5 tests 18–19 |
| SF30 | No alert on deploy-path residual | Adopted | AWS §2 EventBridge (CloudFormation, EC2, SSM, releases bucket) |
| SF31 | Budget alert fires monthly | Adopted (plus owner directive) | AWS §2 (forecast $25, actual $30; Cost Anomaly Detection at $5 impact) |
| SF32 | Export contents contradictory | Adopted | DM §10 (explicit tables per type, `foreign_suppression_key`, never-exported list); WP §9.2; TOP §7 |
| SF33 | Import flow cannot run | Adopted | MCP §7 `/v1/import/estimate`; WP §10.5 (batch-bound 60-minute multi-use token, 1 MiB, resume); IMP §1; SEC §5.2, §6.2 |

### 14.3 Traceability failures (R3 §4)

| Finding id(s) | R3 fix | Status | Where |
| --- | --- | --- | --- |
| R2A N4, R2S E6, Risk 2, D-7 | SF26 | Adopted | SEC §6.2 |
| R2S W6, D-18, Risk 7 | B3 | Adopted | AWS §3; ADR-0020 |
| R2A N15, M15 | SF9 | Adopted | DM §2; WP §8.3 |
| R2A N2, M2 | SF8 | Adopted | WP §5 D10a |
| R2A N14, M14, C24 | SF11 | Adopted | WP §2.3 |
| R2A N16, M16, R2F M1.4 | SF12 | Adopted | MCP §5 |
| R2A N20, M18 | SF13 | Adopted | DM §12 |
| R2A N8, C12 | SF15 | Adopted | DM §3 |
| R2A N31 | SF16 | Adopted | POL §10 |
| R2A N3, ADR-0003 | SF17 | Adopted | WP §5 D15 |
| R2A N10, R2F B1 | SF18 | Adopted | POL §6 |
| R2S X1, X2, Risk 8, D-12 | SF28 | Adopted | DM §9; AWS §5.3 |
| R2S O1, Risk 1, ADR-0017 | SF5, SF29 | Adopted | SEC §4 |
| R2S P2 (rejection) | SF20 | Adopted; reason rewritten | §5 row P2, §13 |
| R2A N25, R2S D-3 | SF21 | Adopted | POL §7.2 |
| R2A M26 | SF32 | Adopted | DM §10 |
| R2A N13, M13 | SF33 | Adopted | MCP §7 |
| R2F M0.6 | B2, B5, SF2, SF3 | Adopted | AWS §3.3, §3.6, §5.2, §7.4 |
| R2F M0.4, ADR-0015 | B4 | Adopted | EV §3.2, §4; ADR-0022 |
| R2F row 29, R2S B4 | SF1 | Adopted | AWS §5.1 |
| R2A C22, N32d | B1 | Adopted | D §9.1 |
| R2A N32e (domain) | B1 | Adopted | D §3 |
| Weak rejection P2 | SF20 | Adopted | as above |
| Weak modification D-2 | SF20 | Adopted | ADR-0003 |
| Weak modification B18 (Playwright) | Document as M2-only | Adopted | EV §8.2 |

### 14.4 Contradictions (R3 §5)

| Value or name | Status | Where |
| --- | --- | --- |
| When the domain is needed | Fixed: before M0 | D §9.1; AWS §6 |
| `onlyBuiltDependencies` | Fixed: includes `argon2` | SEC §10 |
| `policy P1` in every text | Fixed | POL §6 |
| Import session key | Fixed: `import:<batch_id>:<conv>` | WP §2.2 |
| T3 vs T3 one-slot | Fixed: update | IMP §4 |
| Store HMAC key in exports | Fixed: in every full export | TOP §7; WP §9.2; DM §10 |
| Plain vs auth export tables | Fixed: explicit lists | DM §10 |
| Re-import changes nothing | Fixed: content hash | DM §12; IMP §6; EV §3 |
| Forget→undo identity | Fixed: content hash | WP §14 |
| Purge window | Fixed: 30 days (plus 48 hours on the instance) | SEC §1.4; AWS §5.3 |
| Restore drill reference | Fixed: DESIGN.md §7 | AWS §5.5 |
| Spooled supersedes | Fixed: dead clause removed | WP §8 rule 0 |
| Reason code `repo_not_enabled` | Fixed | WP §5.2 |
| Step-up token use for import | Fixed | SEC §6.2; WP §10.5 |
| Dry-run auth | Fixed: `/v1/import/estimate` with `memory.read` | MCP §6–7 |
| Operator permissions | Fixed: defined separately | AWS §3.4 |
| Export recipients | Fixed: server-side list | DM §10; CFG §4.2 |
| Litestream config shape | Fixed | AWS §5.1 |
| App checkpoint under Litestream | Fixed | DM §1, §9 |
| Chat recurrence on one day | Fixed: 6-hour bucket | WP §2.3 |
| ADR-01xx granularity | Fixed | D §6; M0 §4 |
| ADR-0004 status | Fixed: `proposed` | ADR-0004 |
| Owner non-goal vs binding decision | Fixed | D §1 |
| `cacheScope` | Fixed: `private` | MCP §1 |
| Litestream LTX retention row | Fixed | AWS §5.3 |
| Budget alarm vs expected cost | Fixed | AWS §2 |
| Units shipped to CloudWatch | Fixed: five plus `ma-maint` | AWS §2 |

### 14.5 Fact checks marked wrong or partial (R3 §6)

| Claim | Status | Where |
| --- | --- | --- |
| Elicitation details | Fixed (MRTR) | MCP §5 |
| DCR deprecated in 2026-07-28 | Stated; DCR only as a fallback inside a window | SEC §4.2 |
| oidc-provider RFC 8414 path needs app routing | Fixed | SEC §4.7 |
| onnxruntime-node `postinstall` downloads binaries | Q14 tests with scripts off and with only its script allowed | M0 Q14 |
| Litestream YAML shape | Fixed | AWS §5.1 |
| "Litestream tolerates application checkpoints" | Fixed | DM §1 |
| AWS SSO "1-hour session" | Fixed | AWS §3.1 |
| Claude custom connectors accept client id and secret | Used as default | SEC §4.2 |

### 14.6 Over-engineering (R3 §7)

| Id | Item | Status | Where |
| --- | --- | --- | --- |
| OE1 | Two OAuth spikes | Cut | M0 §1, Q15; ADR-0004 |
| OE2 | Weekly age export | Cut | AWS §5.3; OPS §4; ADR-0012 |
| OE3 | Object-Lock manifest | Deferred to M4 | AWS §2, §5.4; D §7 |
| OE4 | Local + tunnel mode | Cut to a README note; local-only kept (owner requirement) | TOP §1; ADR-0023 |
| OE5 | `search`/`fetch` aliases | Cut | MCP §1 |
| OE6 | Debug plaintext logging | Cut | OPS §1; CFG §5 |
| OE7 | Optional projections and managed-block hashing | Deferred; Cursor policy-only rule kept (reason in ADR-0023) | CLI §5; ADR-0009 |
| OE8 | 22 CLI admin commands | Cut to seven; `review` kept in the CLI (ADR-0023) | CFG §4.2; MCP §7; SEC §6.2 |
| OE9 | Eval scale | Smaller gate sizes; full sizes, ablation and external baselines in the M5 report; baselines kept (owner decision); spot-check 50 in total (owner decision) | EV §3, §4, §7; ADR-0023 |
| OE10 | Section-threshold calibration in M1 | Deferred after M3; automatic sections kept (owner decision) | WP §12; POL §9.2 |

### 14.7 Recommendations (R3 §8)

| Recommendation | Status | Where |
| --- | --- | --- |
| Claude static confidential client by default | Adopted | SEC §4.2 |
| Grok and generic clients keep floor and narrowed sections; granting all sections lifts the floor | Adopted | CLI §2 notes |
| Sensitive approvals choose recalling clients | Adopted | POL §7.2 |
| Static confidential refresh tokens 180 d absolute, 30 d idle; PC 30 d | Adopted | SEC §5.2 |
| Operator work in CloudShell or a separate OS account | Adopted (CloudShell) | AWS §3; ADR-0020 |
| Budgets $25 forecast, $30 actual | Adopted | AWS §2 |
| Short-lived lexicon additions | Adopted | POL §3.6 |

### 14.8 Owner questions (R3 §9)

| Question | Resolution |
| --- | --- |
| Q1 Domain | Owner directive: a subdomain of an existing domain, DNS at Cloudflare (§14.9); value kept out of the repository |
| Q2 ChatGPT on the phone | Owner default: stays a goal; M0 Q01 tests the app and the phone browser; if neither works, a known limitation with re-test triggers (ADR-0019), no redesign |
| Q3 Eval spend | Owner default: optional personal keys, hard cap $30, separate from the $20 import budget; M0 passes without them (ADR-0022) |

### 14.9 Coordinator's owner-level directives

| Directive | Status | Where |
| --- | --- | --- |
| `MA_DOMAIN` required M0 input; pre-M0 checklist step; every "before M2" for the domain updated | Done | D §3, §9.1; M0 §1; CFG §7; AWS §6; TOP §7 |
| DNS at Cloudflare; subdomain only; apex and existing records untouched; Route 53 removed from the owner path, kept as an option | Done | AWS §2, §6.2, §6.4; ADR-0024 |
| Owner value never in a public repo file; examples use a placeholder | Done | AWS §6.1 (local config only; CI check); every example uses `memory.example.com` or `{host}` |
| Owner adds an A record, DNS only (grey cloud), reasons stated | Done, with one deviation: a second A record for `admin.{host}`, because the admin UI must be its own origin | AWS §6.2; ADR-0024 |
| CAA on the subdomain only; accounturi checked for a subdomain record | Done: works per RFC 8657/8659; kept optional because each new instance has a new ACME account | AWS §6.2 |
| DNSSEC, Cloudflare and Route 53 statements checked; teardown and dangling DNS: owner deletes the record, IP released only after | Done | AWS §6.2–6.4, §10; SEC §1.4, §1.5; OPS §2 `dns_mismatch` |
| Hostname in CT logs; not a secret | Done | AWS §6.1; SEC §1.5 |
| ChatGPT on the phone is a goal | Done | §14.8 |
| Eval budget $30, optional, M0 passes without keys | Done | §14.8 |
| B3: real separation, easiest for one person, exact `~/.aws/config` and steps | Done | AWS §3.1–3.2 |
| SF26: server-rendered approval text; export fingerprint; second confirmation for unregistered recipient | Done | SEC §6.2 |
| T2 overwriting profile key facts fixed; ChatGPT-floor reason rewritten | Done | WP §8 rule 4a; §5 row P2 |
| Only owner-confirmed projects in the career-os export | Done | DM §11; POL §10 |
| Litestream v0.5 layout, read lock during purge, staging files, pre-update and pre-migration copies with retention | Done | AWS §5.1, §5.3; DM §1, §9 |
| Budget above the expected bill plus an anomaly alert | Done | AWS §2 |
| Prefer static credentials for the Claude connector; keep CIMD for Claude Code where needed | Done | SEC §4.2–4.3 |


## 15. Round-4 re-check (R4)

Every R4 finding is adopted; none is rejected. Where the re-check offered options, the one simplest for a single owner was taken (named in the row).

### 15.1 Blockers

| ID | Status | Fix | Where |
| --- | --- | --- | --- |
| R4-B1 | Adopted (extended per owner context) | AWS Organizations enabled in the existing account (management account); a dedicated member account `memory-anywhere`; Identity Center as an **organization instance**; users `ma-deploy` and `ma-operator` with different plus-addressed emails (placeholders only); the predefined `AdministratorAccess` permission set created before the bootstrap, assigned temporarily to `ma-operator` on the member account only, and removed by the bootstrap; the bootstrap split into a member-account script and a management-account script that creates and assigns both permission sets in the member account only | D §9.1 steps 3–6; AWS §3.1–§3.3; ADR-0025; ADR-0020 |
| R4-B2 | Adopted | M0 builds the `packages/client` deploy subcommands only (`mema deploy aws`, `mema destroy aws`, implementing AWS §6.2–§6.3, §7.1, §7.4); non-goal reworded to "no core code beyond the deploy subcommands" | M0 §1; D §7 M0 row; CFG §1 npm row |
| R4-B3 | Adopted | Spike stack runs Litestream and `ma-maint` as in AWS §4–§5.1 against the spike backup bucket (Litestream probe in M0 §1); spike endpoint is `https://spike.{host}` | AWS §9; M0 §1, §2 |

### 15.2 Should-fixes

| ID | Status | Fix | Where |
| --- | --- | --- | --- |
| R4-S1 | Adopted | Operator set gains the CloudShell actions (account-scoped) and SSM parameter access on `/memory-anywhere-spike/*` and `/memory-anywhere-eval-*/*`; in M0/M1 `ma-operator.sh` comes from the reviewed commit (clone plus SHA check), from M2 from the release; Q26 checks this | AWS §3.2, §3.4; M0 §4 Q26 |
| R4-S2 | Adopted (pinned binary) | User data installs a pinned minisign arm64 binary checked by SHA-256; the updater verifies with `minisign -V`; the release key is generated with `-W` (no password), stored as a GitHub environment secret | AWS §4 step 2, §7.3 step 2, §7.4; ADR-0021 |
| R4-S3 | Adopted | Q14 model choice and `abstain_cosine` use the 100-question LongMemEval-S dev subset; the 200-question test subset is used only for reported baselines and gates | EV §3.2, §10; WP §12; M0 §4 Q14; ADR-0005 |
| R4-S4 | Adopted | `~/.aws/config` has no `region` line until Q20 runs; Q20 runs first in M0; AWS CLI v2, minisign and age added to the install list | D §9.1 steps 4, 6; AWS §3.2 part B; M0 §4 |
| R4-S5 | Adopted | Conformance tests run on node-oidc-provider, and on Better Auth only if Q15 triggers it | M0 §5 heading |
| R4-S6 | Adopted | Rule 4a also requires `cur` tier = T2; matrix text matches | WP §8 rule 4a, §8.2; ADR-0003 |
| R4-S7 | Adopted | Promotion of a `kind = preference` observation also creates a `preference_confirm` review item | WP §8.3 step 3 |
| R4-S8 | Adopted | `./ma-operator.sh setup-link` renews a missing or expired token through `memory-anywhere-server setup-token --renew` (only with no owner, or after an executed reset); a restart creates no token; `reset-owner` writes no token at `effective_at` | SEC §3.1 step 6, §3.3; AWS §3.2 operator table; CFG §4.4 |
| R4-S9 | Adopted (root only) | Request-tag condition removed; on `prod`, `DeleteObjectVersion` and `DeleteBucket` are allowed only to the member account's root; `delete-data` on `prod` prints the root-console steps; non-prod deletes stay with the operator | AWS §3.4, §5.2, §3.2 operator table |
| R4-S10 | Adopted | The hourly DNS check uses DNS over HTTPS on 443, URL pinned as `[deployment] doh_url` | AWS §7.3 step 7; CFG §5 |
| R4-S11 | Adopted | Rate limits keyed on the real routes `/oauth/reg`, `/oauth/auth`, `/oauth/interaction/*`, `/pair/*` | OPS §3 |
| R4-S12 | Adopted | (1) pre-copies and staging files zeroed before deletion (`shred -n0 -z -u`), and offline compaction (`maint --compact`: `VACUUM INTO`, old files shredded) so freed blocks do not survive in later snapshots; (2) `MemorySwapMax=0` on the server unit; (3) live-file row reads "≤ Litestream checkpoint interval (≤ 24 h)"; (4) `ma-maint` runs weekly regardless and nightly after a purge; (5) S-PURGE also scans `/dev/nvme0n1` and swap on the eval stack | DM §9; AWS §4, §5.3; CFG §4.4; OPS §4; EV §3.5 |
| R4-S13 | Adopted | "cannot run on `prod` without a stack change, which is alerted" | ADR-0021; AWS §7.4 |
| R4-S14 | Adopted (exclude) | Store hash excludes `pending_elicitation`, `export_log`, `owner_reset` and the `meta` keys `cookie_secret`, `mrtr_key` | DM §12; AWS §5.5 |
| R4-S15 | Adopted (RTO note) | With CAA `accounturi` on, the RTO includes a manual DNS edit; `./ma-operator.sh acme-account` prints the new account URI to paste | AWS §6.2, §3.2 operator table |
| R4-S16 | Adopted | `memory-anywhere-server import-export --prepare / --in <file> [--include-auth]`, driven by `./ma-operator.sh import-export` (one-time age key on the instance, re-encryption on the PC, transfer through `s3://…/transfer/` and the outbox); alert `store_imported`; the owner creates an age keypair before M2 and registers its public key after setup | AWS §5.6, §3.5; CFG §4.3, §4.4; TOP §7; OPS §2; D §7, §9 |

### 15.3 Owner context for R4-B1

| Item | Status | Where |
| --- | --- | --- |
| Dedicated member account by default; existing account becomes the management account | Done; no serious reason against found (ADR-0025 records the check); Budgets and Cost Anomaly Detection in a member account checked by M0 Q27, with a management-account fallback | AWS §3.1; ADR-0025; M0 §4 Q27 |
| Organization instance of Identity Center; permission sets assigned to the member account only | Done; M0 Q25 checks that `ma-deploy` lists only that account | AWS §3.2–§3.3; M0 §4 Q25 |
| Exact owner steps in order, including creating `AdministratorAccess`, the temporary assignment and its removal | Done | AWS §3.2 part A, §3.3; D §9.1 |
| Single-account path for other self-hosters | Kept, documented as working (permission sets assigned to the management account itself) but not recommended | AWS §3.1 note; ADR-0025 |
| Different emails for the two users; plus-addressing; placeholders only | Done (`you+ma-deploy@example.com`, `you+ma-operator@example.com`, `you+ma-aws@example.com`); no real address in the repository | AWS §3.1; D §9.1 |


## 16. Final re-check (R5)

Every R5 finding is adopted; none is rejected.

| ID | Status | Fix | Where |
| --- | --- | --- | --- |
| R5-B1 | Adopted | The permission sets get no permissions boundary; each is bounded by its own allow list and explicit denies. `memory-anywhere-boundary` stays only on the roles the stack creates (the cfn-exec IAM condition). No separate identity boundary | AWS §3.3 step 3 and the boundary paragraph after step 4; AWS §3.4 intro |
| R5-S1 | Adopted | `bootstrap-identity.sh <member account id> <identity-center region>`; every `sso-admin` and `identitystore` call uses that region; the script prints the region and instance ARN and waits for `yes`; the owner notes the Identity Center region when enabling it | AWS §3.3 step 3, §3.2 A.3; D §9.1 step 3 (record column) |
| R5-S2 | Adopted | One-time key in `inbox/key/` (0700, `memory-anywhere`); drop directory `inbox/drop/` (2770, owner `ma-aws`, group `memory-anywhere`, files 0660) that the outbox fetch writes and the server reads | AWS §4 outbox unit row; AWS §5.6 steps 1 and 3 |
| R5-S3 | Adopted | `cmd /c "age -d … \| age -r … -o export.transfer.age"`; PowerShell 7.4+ may run the pipe directly; always `-o`, never `>` | AWS §5.6 step 2 |
| R5-S4 | Adopted | Litestream `meta-path: /run/litestream/store` on tmpfs (`RuntimeDirectory=litestream`, removed when the unit stops, `MemorySwapMax=0` on the unit); on-disk staging handling removed; S-PURGE expects no Litestream file on the volume. Consistency fix in the same pass: the README purge guarantee no longer says "gone from the live database file at once" (contradicted by the R4-S12 live-file row); it now says unreadable through the store at once, gone from every file and from memory on the instance within 48 hours | AWS §5.1 (YAML and bullets), §4 `litestream.service` row, §5.3 staging and freed-blocks rows and guarantee sentence; DM §9 staging and freed-blocks rows and S-PURGE paragraph; EV §3.5 S-PURGE |
| R5-S5 | Adopted | `ma-maint` clears `/run/litestream/store` after the file swap and before starting Litestream, which then takes a new snapshot; Q21 runs a full `ma-maint` cycle and passes only if a fresh `litestream restore` matches the post-compaction ordered-dump hash; fallback adds `litestream reset` | AWS §4 `ma-maint` row; M0 §4 Q21 |
| R5-S6 | Adopted | `embed-bench/` uses the 100-question dev subset for the choice and reports on the 200-question test subset | M0 §1 `embed-bench/` line |
