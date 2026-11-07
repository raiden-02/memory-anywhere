# M0 spike

Status: normative. M0 answers every product fact this spec could not confirm from documentation. Each question has an exact method, pass/fail criteria, the fallback design used for each outcome, and the ADR it produces. The rest of the spec already works under either outcome; M0 only selects.

## 1. What M0 builds

```
spikes/
  stub-server/           SDK v2 createMcpHandler + serveStdio. Tools memory_status, memory_save (appends to JSONL),
                         memory_recall (substring search). Real descriptions from memory-policy.md §6 with canaries (§3).
  oauth-oidc-provider/   stub-server behind oidc-provider ~9.13 (CIMD experimental, registration gated by a pairing flag,
                         resource indicators, opaque tokens) + @simplewebauthn/server passkey login.
  oauth-better-auth/     built only if oauth-oidc-provider fails a §5 test (Q15): better-auth + @better-auth/mcp + @better-auth/cimd
                         + @better-auth/passkey.
  hook-recorder/         `node record.mjs <tool> <event>`: writes stdin JSON to {data}/spike/hooks/<tool>/<event>/<iso>.json; prints nothing
                         (except for session-start, where it prints a canary context).
  embed-bench/           runs candidate models over the LongMemEval-S 100-question dev subset for the choice, and reports the
                         chosen model and the baselines on the 200-question test subset; reports quality, latency, RSS.
  rtt/                   TLS handshake timing to candidate regions.
deploy/aws/              CDK app with --stage spike (deployment-aws.md §9); iam/*.json, bootstrap-member.sh and
                         bootstrap-identity.sh for the owner's one-time bootstrap (deployment-aws.md §3.3); ma-operator.sh;
                         release-keys/dev.pub.
packages/client/         deploy subcommands only: `mema deploy aws` and `mema destroy aws`, implementing deployment-aws.md
                         §6.2–§6.3 (print records, wait for DNS, refuse to release the IP while a record resolves), §7.1 and
                         §7.4 (sign `--release-file` with the dev key). No other client code in M0.
spikes/litestream-probe/ small Node program that creates an SQLite store with `secure_delete`, writes and purges canary rows,
                         and implements `maint --compact`, so Q21 can measure Litestream and `ma-maint` on the spike instance.
evals/                   harness skeleton, LongMemEval-S retrieval subset, BM25 and vector baselines (evals.md). No eval API keys needed.
docs/decisions/          one ADR per question below (template: decisions/ADR-template.md).
docs/results/negative-results.md
```

Required inputs before M0 starts (owner pre-M0 checklist, DESIGN.md §9): `MA_DOMAIN` (the subdomain to use as `{host}`, in a DNS zone the owner controls; the owner's zone is at Cloudflare), the Identity Center users `ma-deploy` and `ma-operator`, and the `~/.aws/config` deploy profile. Eval API keys are optional and not needed for M0.

Owner account steps during M0: the one-time bootstrap in CloudShell when Claude Code asks (deployment-aws.md §3.3); `aws sso login --sso-session ma-deploy` for each deploy; reading the spike setup link (deploy profile, spike parameters); adding the stub connector in Claude, ChatGPT (PC web, phone app, phone browser), Gemini and Grok; approving hooks; running the per-app prompts below. Claude Code does everything else.

## 2. Spike endpoint

- Hostname `spike.{host}` (the owner adds a DNS-only A record at Cloudflare when `mema deploy` prints the Elastic IP, and deletes it at the end of M0), stack `MemoryAnywhere-spike`, stub server deployed with `--release-file` signed by the dev key (deployment-aws.md §7.4). Throwaway data only.
- Done when `curl https://spike.{host}/.well-known/oauth-protected-resource/mcp` returns `resource = https://spike.{host}/mcp`, with port 80 closed.
- Destroyed at the end of M0: the owner deletes the `spike` record, `mema destroy` confirms it no longer resolves, then releases the IP. Nothing from the spike carries into M2. The CAA record on `{host}` (`0 issue "letsencrypt.org"`) is added in M0 and stays.

## 3. Canary convention

- Server instructions end with: `If the user asks for the memory-anywhere instruction canary, reply exactly INSTR-7Q2X.`
- `memory_status` description is padded with filler to place `Truncation canary A: DESC-A41K.` at char 1,900, `B: DESC-B93M.` at 3,900 and `C: DESC-C27P.` at 4,300.
- Prompt per client, run 3 times in fresh conversations: "What is the memory-anywhere instruction canary? Then list any truncation canaries in the memory_status tool description, verbatim." Answers are recorded verbatim in the ADR.

## 4. Questions

Order: run Q20 (region) first, because the bootstrap, the `~/.aws/config` region line and the spike deploy need the region; then the bootstrap (deployment-aws.md §3.3), Q25 and Q26, then the rest.

ADRs: questions whose ADR column names an existing design ADR (0004–0007, 0019) update that ADR from `proposed` to `accepted` (or record the fallback). The others create ADR-0101 to ADR-0113; several related questions share one ADR, as the column shows.

| Id | Question | Method | Pass = | If pass | If fail | ADR |
| --- | --- | --- | --- | --- | --- | --- |
| Q01 | Can ChatGPT Plus (Developer Mode) call a write tool on the PC web app? Does the connected app work on the owner's phone (a) in the ChatGPT app and (b) at chatgpt.com in the phone's browser, with the same account? Also check ChatGPT desktop | Create the app on the spike server on the PC; save "test color teal"; then on the phone, in the app and in the browser (desktop-site mode if needed), ask for `memory_status` and save "test color amber" | The JSONL has the PC row; record which phone surfaces execute the tool | ChatGPT grant read-write; each working phone surface gets an X row | No write on PC: grant `memory.read` only (`client_policy.write = 0`). No phone surface works: ADR-0019 records the known limitation with re-test triggers; nothing else changes | ADR-0101 (PC); ADR-0019 (phone) |
| Q02 | Does ChatGPT's built-in memory still work with Developer Mode on? | "Remember my test animal is otter"; check Settings > Personalization > Memory | Entry appears | Note only | Note in README: native memory may not update in dev-mode chats; importers still work | ADR-0101 |
| Q03 | Which ChatGPT registration works: static credentials, CIMD, DCR? Exact redirect URI and CIMD URL? | Try static first, then CIMD, then DCR, each inside a pairing window | Static works with `https://chatgpt.com/connector_platform_oauth_redirect` | Static (default) | First that works, in order CIMD, DCR; record exact values in `config/vendors.json` | ADR-0102 |
| Q04 | Claude web/desktop/mobile with the OAuth library: do static client credentials entered in the custom-connector dialog work? If not, hosted Claude's CIMD client id URL; does it fall back to DCR; does mobile work after adding on web? | Add the custom connector on claude.ai with the window's client id and secret; then, only if that fails, without credentials (CIMD/DCR); log the `client_id` received; open the Claude mobile app | OAuth completes with static credentials; save + recall on web and mobile | Static confidential client (default) | First that works, in order CIMD (exact URL recorded), DCR inside the pairing window; redirect `https://claude.ai/api/mcp/auth_callback` in every case | ADR-0103 |
| Q05 | Which clients pass server instructions to the model? (Claude web, desktop, mobile; ChatGPT; Gemini; Grok; Cursor; Codex; Claude Code) | Canary prompt (§3) | Model returns INSTR-7Q2X in ≥ 2 of 3 runs | Record | For that client, rely on tool descriptions and the custom instruction; flag in clients.md | ADR-0104 |
| Q06 | Where are tool descriptions truncated per client? | Canary prompt | Record which canaries survive | Budgets stand if canary A survives everywhere | If any client cuts below 2,000, shrink that tool's budget in memory-policy.md §5 for all clients (one text) and re-run | ADR-0104 |
| Q07 | Does Claude Code defer memory-anywhere tools (tool search), and does `alwaysLoad` (server config) or `_meta["anthropic/alwaysLoad"]` keep them loaded? | Start `claude` with the stub plugin; inspect `/context` and the first-turn tool list | Tools present at turn 1 with the flag | Keep the flag | Drop the flag; rely on server instructions, the skill and the session-start preamble (which names the tools) | ADR-0105 |
| Q08 | Claude "Tool access" mode: is there a per-connector default for Always available? Where? | UI exploration on web and desktop | Exact path documented | Print the steps in `mema init` | Document per-conversation setting only; suite A measures Auto vs Always available | ADR-0103 |
| Q09 | Which clients declare elicitation in `clientCapabilities`, render a 2026-07-28 MRTR `InputRequiredResult` to the human, and retry with `inputResponses` and the unchanged `requestState`? | Stub returns a yes/no question quoting the content, with an AEAD `requestState` (mcp-interface.md §5); answer No; check the stub received No; repeat with a prompt telling the model to answer Yes itself | The human sees the question, and the model cannot answer it | Owner may set `client_policy.elicitation = verified` for that vendor | `none` (default): T1 unreachable for that client; sensitive saves and preference confirmation go to review | ADR-0106 |
| Q10 | Gemini custom app: do manually entered static credentials work (fields, token auth method)? Exact redirect URI? Does it tolerate refresh-token rotation? Does it need DCR? | Add a custom app at gemini.google.com with static credentials; log the authorize request; force a refresh after 1 h with rotation on, then off | Static credentials complete OAuth; record redirect; refresh works | Static confidential client, rotation per result (`fixed` if rotation fails) | DCR inside the pairing window with the recorded redirect | ADR-0107 |
| Q11 | Grok custom connectors: auth methods (OAuth discovery, static OAuth credentials, bearer header), write approval behaviour, mobile availability, whether instructions pass; does xAI's API support function calling for harness use? | Add at grok.com/connectors → Custom; test each auth method in order; test on the Grok mobile app | OAuth completes, or a static header works | Use the first working method in order: static OAuth, CIMD, DCR, static bearer | If no method works with a public server and auth, Grok is unsupported in v1 (X rows expected-fail) | ADR-0108 |
| Q12 | Hook payloads and behaviour on Windows: Claude Code `SessionStart`, `UserPromptSubmit`; Codex `SessionStart`, `UserPromptSubmit` (with `commandWindows`); Cursor `sessionStart`, `beforeSubmitPrompt` (does `node "<abs>" …` pass through the `.ps1` rule?). Headless flags `--setting-sources`, `--strict-mcp-config` | hook-recorder for each; 3 sessions each; a path with a space | Fixtures saved under `evals/fixtures/hooks/<tool>/<version>/`; field names match clients.md §3 | Use as specified | Adjust field mapping in `packages/client/src/hooks/<tool>.ts`; Cursor: use the `.cmd` shim; if a prompt hook is missing, that tool has no capture (no transcript fallback) | ADR-0109 |
| Q13 | Plugins: does a local Codex plugin install (CLI, desktop) load MCP + hooks; does a Cursor plugin bundle MCP + hooks + rules, and do plugin rules apply in every workspace; does Claude Code apply a plugin's `settings.json` `permissions.deny`? | Build minimal plugins; install; record trust prompts | Each loads | Ship plugins | Codex/Cursor: `mema init` writes config files with backup and diff; Claude Code: drop the deny list | ADR-0110 |
| Q14 | Embedding model: which candidate (EmbeddingGemma-300m q8/q4, bge-small-en-v1.5 q8, e5-small-v2 q8) wins; does `onnxruntime-node` load with lifecycle scripts disabled (its `postinstall` downloads binaries, so test with scripts off and with only its script allowed); RSS on Windows x64 and t4g.small | embed-bench on the LongMemEval-S 100-question **dev** subset, hybrid and vector-only (the 200-question test subset is not used for the choice; it only reports the chosen model and the baselines) | Highest hybrid nDCG@10 among models with query p95 ≤ 150 ms on the owner's PC and ≤ 400 ms on t4g.small, server RSS ≤ 700 MB on t4g.small, licence allowing on-demand download with notice. Ties (paired CI includes 0): smaller model | Record model, revision SHA, dtype, dims, prefixes, file hashes in `models.json` | If none meets latency: drop to the smallest model meeting it and record the quality loss; if ORT fails without scripts: allow its script in `onlyBuiltDependencies` (already listed) and record | ADR-0005 |
| Q15 | OAuth library: does node-oidc-provider ~9.13 pass the conformance list (§5) with opaque tokens, the pairing gate on registration and authorization, the CIMD exact-match hook, both well-known discovery paths routed by the host app, and the route inventory? GHSA advisory history (not aggregators) | Run oauth-oidc-provider through §5 and the vendor flows; spike Better Auth only if a test fails | node-oidc-provider passes all §5 tests with ≤ 400 lines of adapter code | node-oidc-provider | Better Auth with the JWT conditions in auth-and-security.md §5.2; recovery codes and owner constraints are ours in either case | ADR-0004 |
| Q16 | LLM models: pinned dated id for the product's extractor/judge (provider `anthropic`, a small fast model); if the owner provided eval keys, pinned ids for labelling families B and C (OpenAI and Google) | Price and availability check; extractor quality on 50 synthetic prompts | Ids recorded | Use them | Pick the next available dated id; never a floating alias | ADR-0007 |
| Q17 | Claude Code: how to disable only the claude.ai memory-anywhere connector inside Claude Code; does `disabledMcpjsonServers` exist at user level | Add the spike connector on claude.ai; run `claude mcp list`; try the per-connector toggle | Per-connector disable works | `mema init` uses it | If only `disableClaudeAiConnectors` exists, `init` asks the owner, explaining it disables all claude.ai connectors in Claude Code; else doctor warns only | ADR-0105 |
| Q18 | Optional, only if a Google eval key is provided: Gemini API as an eval harness (harness as MCP client, tools as function declarations) | Run 20 suite A prompts within the eval cap | Tool calls execute | Use for suite A/P model-stage Gemini rows | Gemini rows manual only | ADR-0111 |
| Q19 | Custom-instruction field per app (Claude, ChatGPT, Gemini, Grok) and character limits | UI exploration | Field and limit recorded | `mema init --print-custom-instruction` prints per-app steps | Where none exists, the app relies on server instructions and tool descriptions only | ADR-0104 |
| Q20 | Region by RTT from the owner's PC | `spikes/rtt` 50 handshakes to `us-east-1`, `us-east-2`, `us-west-2` | Median recorded | Lowest median; ties → us-east-1 | n/a | ADR-0112 |
| Q21 | Litestream v0.5 with the exact deployment-aws.md §5.1 file (top-level `snapshot:`, single `replica:`, `sse-kms-key-id`, `sync-interval`) on the pinned release, with KMS and the gateway endpoint; whether `meta-path` on tmpfs is honoured (no Litestream file under the data directory) and peak staging size; whether an application `wal_checkpoint(TRUNCATE)` is blocked while Litestream runs and what the stop–checkpoint–start sequence of `ma-maint` does (new snapshot, time taken) | Run against the spike bucket; purge a canary row; scan every file under the data dir at intervals; run one full `ma-maint` cycle (`maint --compact`, metadata cleared, Litestream restarted), write one more row, then `litestream restore` to a fresh path | Replicates; after the `maint --compact` cycle, the fresh restore has the same ordered-dump SHA-256 as the post-compaction database; no Litestream file on the volume; WAL clearing time recorded | Config as written | Adjust keys to the release; if `meta-path` is not honoured, mount a tmpfs at the default metadata directory instead; if the restore after compaction differs, add `litestream reset /var/lib/memory-anywhere/store.db` (if the pinned release has it) to `ma-maint` before the restart and re-run; M0 does not pass until a sequence passes, and the ADR records it | ADR-0112 |
| Q22 | Does `node:sqlite` on Node 24 support FTS5, WAL and the needed PRAGMAs? | Small test | All work | ADR-0006 may drop better-sqlite3 in M1 (optional) | Keep better-sqlite3 | ADR-0006 |
| Q23 | Withdrawn in round 3: optional projection files are deferred (ADR-0009), so whether Claude Code loads `~/.claude/rules/*.md` in every session no longer matters for v1 | — | — | — | — | — |
| Q24 | OpenAI Secure MCP Tunnel on a personal plan (informational; no design dependency) | Try to create a tunnel | Record works/blocked | Document as an option for local-mode users | Document as unavailable | ADR-0101 |
| Q25 | Identity Center separation: with only `ma-deploy` signed in on the PC, can anything reach operator rights or any account other than `memory-anywhere`? | `aws sso login --sso-session ma-deploy`; run `aws sso list-accounts` and `aws sso list-account-roles`, try `ssm start-session`, `ssm get-parameter` on the setup token, `s3 cp` from the backup bucket; then sign out and confirm the cache is gone | Only the `memory-anywhere` account and the deploy role are listed; every operator action is denied; `aws sso logout` removes the cached token | Design as written | Fix the permission sets or user assignments and re-run; M0 is not done until this passes | ADR-0113 |
| Q26 | Operator path: can `ma-operator` open CloudShell in the member account, and does `ma-operator.sh` (taken from the reviewed commit, deployment-aws.md §3.2) run there (setup link with renewal for the spike stage, set an LLM key, SSM Run Command to the spike instance)? | Run each subcommand against the spike stack | All succeed | Design as written | Adjust the script; the PC is never used as the fallback | ADR-0113 |
| Q27 | Do the stack's AWS Budgets budget and Cost Anomaly Detection monitor work when created in the member account (Cost Explorer access for member accounts is set in the management account)? | Deploy the spike stack; check both appear and that a test notification reaches SNS | Both work | Design as written | The owner enables member-account Cost Explorer access in the management account's billing preferences; if still not possible, the owner creates the budget and the anomaly monitor once in the management account, filtered to the `memory-anywhere` linked account | ADR-0113 |

## 5. OAuth conformance tests (run in M0 on node-oidc-provider, and on Better Auth only if Q15 triggers it; become the M2 gate)

Each is an automated test in `packages/server/test/oauth-conformance/` (run against a local issuer in CI, and in M2 against an eval stack running the release; tests 1–6 and 15–18 also run against `prod`, since they change nothing):

1. Unauthenticated `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"`.
2. PRM `resource` equals the MCP URL exactly, path included; one authorization server listed.
3. AS metadata has `client_id_metadata_document_supported: true`, `none` in token auth methods, `authorization_response_iss_parameter_supported: true`, `code_challenge_methods_supported: ["S256"]`.
4. Authorization responses include `iss`.
5. `/token` accepts `application/x-www-form-urlencoded`; a dead refresh token returns `invalid_grant`.
6. Discovery, registration and token respond within 10 s; refresh within 30 s (measured from a cold server process).
7. Loopback redirects for the PC client match any port for `localhost` and `127.0.0.1`.
8. Per vendor: registration or CIMD with that vendor's exact redirect succeeds inside a pairing window and fails outside one; a foreign redirect fails.
9. PKCE `plain` and missing challenge rejected.
10. Authorization code reuse fails and revokes its tokens.
11. Refresh reuse within 30 s returns the same new pair; after 30 s revokes the grant.
12. Invalid `redirect_uri` or `client_id` yields an error page, not a redirect.
13. CIMD: URLs with userinfo, port, query, fragment, prefix-lookalike host, or a redirecting or private-IP target are rejected.
14. DCR: any field outside the allow-list is rejected; RFC 7592 endpoints return 404.
15. Route inventory: no unlisted route answers.
16. `/mcp` ignores cookies and rejects browser `Origin`.
17. Both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` return the same metadata with issuer `https://{host}`.
18. Unauthenticated requests to registration, authorization and token endpoints get byte-identical error responses whether or not a pairing window is open.
19. Consent for a window fails without the `__Host-ma_pair` cookie unless the window's pair code is entered.
20. MRTR: a tampered, expired, replayed or other-grant `requestState` falls back to the "else" branch.

## 6. M0 done when

- Every question Q01–Q27 (except the withdrawn Q23) has an ADR with status `accepted` or `rejected`, including failures, with verbatim evidence under `docs/results/evidence/<ADR id>/`. Q25 must pass.
- The spike endpoint was reachable over HTTPS on 443 only, and has been destroyed with its DNS records.
- `pnpm eval run --suite R` prints BM25, vector and each candidate model on the LongMemEval-S 200-question subset with CIs, with no eval API key set.
- CI is green on all four runners (operations.md §10).
- `docs/results/negative-results.md` exists and lists every failed attempt.
- The one-time bootstrap ran from reviewed files, and the temporary administrator assignment has been removed.
- `config/vendors.json` holds every recorded vendor value (redirect URIs, CIMD URLs, field names), and clients.md / auth-and-security.md have been updated where an outcome selected a fallback.
