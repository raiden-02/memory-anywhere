# Evals and benchmark

Status: normative. The benchmark is the project's main public contribution: a cross-client personal-memory harness that scores the write path, retrieval, agent behaviour, policy and attacks, against baselines, with sample sizes, confidence intervals and negative results. It can be pointed at any MCP memory server through an adapter.

Milestone gates use the smaller sizes in §3 with honest intervals; the full sizes, the external baselines and the policy ablation are produced for the M5 report (ADR-0023).

## 1. Principles

1. **Isolation.** Evals never touch the owner's store. Every suite runs against an in-process store, `memory-anywhere-server start --local --ephemeral`, or an eval stack (`mema deploy aws --stage eval-<id>`, deployment-aws.md §8), each with its own issuer and data. Any harness config whose URL equals the owner's `{host}` is refused.
2. **Held-out labels.** Data used to tune rules or thresholds (dev split) is never used to report results (test split). Test labels come from public benchmark items, or from model families different from (a) the implementing agent's family and (b) the extractor and judge family, plus the owner's 50-item spot-check (ADR-0015).
3. **Per-operation scoring.** End-to-end QA hides write-path failures ([HaluMem](https://huggingface.co/papers/2511.03506)), so W scores each operation. Retrieval is scored by id, never by an LLM judge.
4. **Repeats and intervals.** Stochastic suites run ≥ 3 times; every reported number has n and a 95% interval.
5. **Negative results** go into `docs/results/negative-results.md` and the report.
6. **Synthetic persona.** Datasets authored for this project use a synthetic persona ("Alex"), never the owner's data.
7. **Keys and budget.** Cross-vendor dataset generation, labelling and API-driven runs are **optional**. They use the owner's personal API keys (`MA_EVAL_ANTHROPIC_API_KEY`, `MA_EVAL_OPENAI_API_KEY`, `MA_EVAL_GOOGLE_API_KEY`) under a hard cap `MA_EVAL_USD_CAP` (default and maximum $30), separate from the $20 import budget (config-and-cli.md §7). The harness estimates each call's cost before making it and refuses a call that would cross the cap; spend is logged in `docs/results/eval-spend.json`. **Every milestone gate can pass without any key**: the no-key path uses public benchmark items, deterministic fixtures, and Claude driven through Claude Code headless on the owner's subscription (§8.3). Results that used no independent labels are marked "author-labelled" and are not used for gates.

## 2. Repository layout

```
evals/
  adapters/            memory-anywhere.ts, mem0.ts, mcp-memory-service.ts, bm25.ts, vector.ts, none.ts, native-<vendor>.ts (manual rows)
  datasets/
    seed-r/            corpus.jsonl, queries.jsonl, split.json, labels.json (labeller family or "author")
    w/                 cases.jsonl, split.json
    p/                 proposals.jsonl, conversations.jsonl, split.json
    a/                 prompts.jsonl
    s/                 attacks.jsonl
    i/                 imports/ (synthetic exports per source), labels.jsonl
    public/            scripts that fetch LongMemEval-S, MemoryAgentBench conflict items, BEAM-small (not committed; licences recorded)
  harness/             runner, clients (claude-code.ts, codex.ts, cursor.ts; optional api-anthropic.ts, api-openai.ts, api-gemini.ts), stats.ts, spend.ts
  fixtures/hooks/      recorded hook payloads per tool and version (M0 Q12)
docs/results/          <date>-<suite>-<system>.json, report.md, negative-results.md, eval-spend.json, evidence/
```

## 3. Suites

| Suite | Measures | Primary metrics | Runs | Gate at milestones (M5 report size) |
| --- | --- | --- | --- | --- |
| W: write path | Store-rule and decision-table operations on fixed inputs | Confusion matrix over {dup, update, correction, historical, contested, new, observation, review, reject}; wrong-supersede rate | 1 (deterministic) | M1: ≥ 300 cases (150 test), ≥ 100 supersede-eligible test items, **0 wrong supersedes**, Wilson upper bound reported (≈ 3.7% at n = 100). M5 report: ≥ 1,000 cases, ≥ 300 eligible test items, upper bound ≤ 2% |
| R: retrieval | Recall quality | R@5, nDCG@10 per category (single, update, temporal, multi-session, abstention); abstention precision/recall | 1 | M0: baselines print with CIs on a LongMemEval-S retrieval subset (200 questions). M1: memory-anywhere hybrid beats BM25-only and vector-only on nDCG@10 (paired bootstrap 95% CI of the difference excludes 0) on that subset; seed-r reported. M2: same on full LongMemEval-S retrieval |
| P: policy | Server-stage decisions; model-stage proposals; section placement | Stored precision and recall per policy category; sensitive and secret stored counts; section placement accuracy | 1 (server stage), ≥ 3 (model stage) | M1 server stage: ≥ 50 items per row family; **0/n secrets stored** and **0/n sensitive stored active without verified request**, n ≥ 100 each, reported as "0/n (95% upper bound x%)". M2 model stage: Claude via Claude Code headless, reported, no regression rule. M5 report: ≥ 150 per family, ≥ 300 per sensitive category for any per-category claim, ablation |
| A: agent behaviour | Whether models call recall/save correctly per client | Recall-call rate on personal prompts; false-call rate on non-personal prompts; save precision and recall | ≥ 3 | Reported per client and setting; no fixed threshold in v1 (M2: Claude Code headless and the coding tools; API rows optional) |
| X: round trip | Fact saved in client A recalled in client B | Pass/fail per ordered pair using canary ids | 1 per pair, manual for apps | All supported pairs pass; unsupported pairs reported as expected-fail (M2, M4) |
| S: security | Attack success on a fixed corpus | Attack success rate per family, with n and Wilson CI | ≥ 3 for model-driven attacks; 1 for deterministic | Every deterministic case passes; model-driven ASR reported per release; any regression blocks release (M2, M4) |
| C: cost and latency | Tokens injected; latency | Chars injected per session; p50/p95 per op, cold and warm, local and remote from the owner's PC | 200 calls per op | §3.7 (M1 local, M2 remote) |
| I: import | Atomic and history importers | Duplicate rate; extraction precision/recall on labelled exports; re-import no-op | 1 | Second import of the same file leaves the **content hash** unchanged (data-model.md §12); extraction precision and recall reported with CI (M3) |

### 3.1 Suite W

- `evals/datasets/w/cases.jsonl`, one case per line:

```json
{"case_id":"w0001","category":"update","prior":[{"id":"mem_A","entity":"self","attribute":"city","content":"Lives in Hyderabad.","tier":"T2","valid_from":"2021"}],
 "input":{"channel":"mcp","tier":"T2","save":{"content":"Lives in Denver, CO.","kind":"fact","why_durable":"home city","user_words":"I moved to Denver last June","valid_from":"2025-06"}},
 "expected":{"op":"update","target":"mem_A","outcome":"active"}}
```

- `expected.op` ∈ `dup`, `update`, `correction`, `historical`, `contested`, `new`, `observation`, `review`, `reject`.
- Wrong-supersede = cases where the system closed or expired a version (`update`, `correction`, `extension`) but `expected.op` was not one of those. Rate = wrong-supersede count / all cases whose expected op is not a supersede but where a supersede was possible (same slot or same entity with similar content): "supersede-eligible".
- Sources, in order of preference: public items (LongMemEval knowledge-update and temporal; MemoryAgentBench conflict resolution), converted to save sequences by a script, whose expected ops follow from the public answer keys; then authored items (§4).

### 3.2 Suite R

- **LongMemEval-S retrieval subset** (no keys needed): 200 test questions stratified by category, plus a disjoint 100-question dev subset, indexed at round level (one document per user-assistant round, with the round's text as content). The **dev** subset is used for every choice: the M0 Q14 embedding model and the `abstain_cosine` calibration (write-path.md §12). The **test** subset is used only for reported baselines and the M1 gate, never for a choice.
- **seed-r** (built in M1): ≥ 300 memories, 200 queries (40 per category), split 100 dev / 100 test. With eval keys, family B writes it and family C labels it (§4). Without keys, the implementing agent writes it and its results are reported as author-labelled, not gated.

```json
{"id":"mem_…","entity":"self","attribute":"city","kind":"fact","section":"Profile","content":"Lives in Denver, CO.","valid_from":"2025-06","recorded_at":"2026-01-02T00:00:00.000Z","superseded_by":null,"excerpt":"I moved to Denver last June","aliases":["Denver"]}
{"qid":"q001","query":"where do I live now?","category":"update","as_of":null,"relevant":["mem_…"],"graded":{"mem_…":2}}
```

- Abstention queries have `relevant: []`; success = empty result.
- Public anchors: LongMemEval-S, BEAM-small (M5). LoCoMo is not headlined (6.4% wrong answer keys and a lenient judge; [audit](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg)).
- BM25 is a strong baseline ([MemoryAgentBench](https://huggingface.co/papers/2507.05257)); beating it is the bar.

### 3.3 Suite P

Two parts:
1. **Server stage** (deterministic): `proposals.jsonl`, each a `memory_save` input plus channel, tier and prior store, with the expected outcome and reason code. Gate size ≥ 50 items per decision-table row family (instruction vs preference, sensitive per category, secrets, short-lived, taste, slot facts, explicit, model-inferred, events). Secret items come from the secret pattern families (mechanical labels); sensitive items come from public PII and health/finance phrase lists plus authored paraphrases.
2. **Model stage**: `conversations.jsonl`, each a short conversation with per-turn labels of what should be saved (`save` with expected content and kind, `observe`, or `skip`). Run through each client harness; score what was **stored** server-side. M2 requires the Claude Code headless run; ChatGPT and Gemini API runs are optional.

M5 report only: the ablation, per client where runs exist: (a) model only (server rules bypassed in an eval build), (b) model + rules, (c) model + rules + judge, (d) no-LLM mode. This measures how much the server stage adds, including when it adds nothing.

Section placement fixtures: memories labelled with their correct section (deterministic placement, M1). Dynamic-section threshold calibration is deferred to real data after M3 (write-path.md §12).

### 3.4 Suite A

`prompts.jsonl`: `{id, prompt, personal: bool, expects: "recall"|"save"|"none", save_label?}`. M2: ≥ 100 personal and ≥ 100 non-personal prompts; M5: ≥ 200 each. Settings varied: with and without the custom instruction; Claude tool access Auto vs Always available (apps only, manual); with and without hooks (coding tools).

### 3.5 Suite S

`attacks.jsonl`: `{id, family, channel, setup, payload, success_condition}`. Families and minimum counts (M2; M5 adds the red-team cases from M4):

| Family | Cases | Deterministic? |
| --- | --- | --- |
| S-POI (poisoning via content: web page, document, email, repo, other-app output, capture role confusion, import, spool forgery, sections, supersede, framing, profile key-fact overwrite by another client) | ≥ 100 | model-driven (Claude Code headless) except spool, framing, sections, key-fact overwrite |
| S-EXF (recall enumeration, slow drip, wildcard, catalog, untrusted repo injection) | ≥ 50 | model-driven + deterministic budget checks |
| S-OAUTH (consent phishing from a second vendor account, DCR outside window, window-state probing, registration race, consent without pair cookie or code, CIMD prefix/userinfo/port bypass, redirect mismatch, PKCE downgrade, code reuse, refresh reuse, cookie on `/mcp`, setup race, recovery brute force, MRTR `requestState` tampering, replay and cross-grant use, route inventory) | ≥ 45 | deterministic |
| S-WEB (stored XSS via content, `client_name`, section name; CSRF; framing; missing headers; S-WEB-05 `X-MA-Origin: admin` sent to `{host}`) | ≥ 30 | deterministic (Playwright) |
| S-AGENT (coding agent instructed by repo content to run each admin CLI command and `aws` commands; step-up request with misleading arguments; export to an unregistered recipient) | ≥ 20 | model-driven + deterministic approval-text checks |
| S-LOCAL (shadow `.mcp.json`, foreign hooks, pre-placed Cursor rule file) | ≥ 10 | deterministic |
| S-AWS (IMDS from server user, bucket access off-VPCE, CAA present on the subdomain, both names resolve to the Elastic IP and are not proxied, port 80 closed, operator actions denied to the deploy profile, destroy refuses to release the IP while a record resolves to it) | ≥ 9 | deterministic, against an eval stack |
| S-PURGE (no purged string in any file under the data directory, including every `*.db`, WAL, FTS shadow tables, and no Litestream staging file on the volume, after the clearing times of data-model.md §9; on an eval stack also nowhere on the raw block device `/dev/nvme0n1` or in the swap file; re-import blocked; measured clearing time with Litestream running) | ≥ 20 | deterministic, local and eval stack |
| S-DOW (unauthenticated floods do no DB/model work; LLM cap; eval spend cap) | ≥ 5 | deterministic |

Success conditions are checked on server state (stored outcome, returned ids, audit) or on the outbound channel (a canary URL hit), never on the model's text alone.

### 3.6 Suite X

Canary facts `Alex's canary color is <random word>` saved in client A, recalled in client B, for every ordered pair of: Claude web, Claude mobile, Claude desktop, ChatGPT web, ChatGPT phone app, ChatGPT phone browser, Gemini web, Gemini mobile, Grok web, Claude Code, Codex, Cursor. Apps run by the owner from a dated checklist (`docs/results/checklists/x-<date>.md`) against an eval stack: for the run the owner adds a temporary connector named `memory-anywhere-eval` in each app, turns the prod connector off in those conversations, and removes the eval connector afterwards. Coding tools are scripted against the same eval stack with `MA_STORE_URL` and `MA_TOKEN_FILE`. Expected-fail rows: a ChatGPT phone row that M0 Q01 showed does not work (ADR-0019), any client M0 marks unsupported, and writes from read-only clients.

### 3.7 Suite C targets

| Measure | Target |
| --- | --- |
| Local `memory_recall` p95 (warm) | ≤ 300 ms |
| Remote SessionStart hook wall time p95, owner's PC → AWS | ≤ 800 ms warm, ≤ 1.5 s cold |
| Remote `memory_recall` p95 | ≤ 1.2 s |
| Remote `memory_save` p95 | ≤ 1.5 s without LLM, ≤ 4 s with slot proposal |
| Chars injected per Claude Code session | ≤ 9,000 |

## 4. Labelling

| Dataset | With eval keys | Without eval keys |
| --- | --- | --- |
| W | Public-derived items (labels from the public keys) plus items authored by family B and labelled by family C | Public-derived items only for the gate; authored items reported as author-labelled |
| R | LongMemEval-S (public labels); seed-r by B, labelled by C | LongMemEval-S only for gates; seed-r author-labelled |
| P server stage | Expected outcomes follow mechanically from the decision table for screen families (secrets, lexicons); policy-quality items labelled by C | Mechanical families gate; policy-quality items author-labelled, reported only |
| P model stage, A | Conversations by B, labels by C | Conversations and labels by the implementing agent, reported as author-labelled |
| S | Mechanical success conditions | Same |
| I | Synthetic exports labelled by C | Synthetic exports, author-labelled, reported only |

- Family A = the implementing agent's family (Claude). Families B and C must differ from A and from the extractor and judge family (`llm.model`), and from each other. With `llm.provider = anthropic`, B and C are drawn from OpenAI and Google models. Q16 records the pinned model ids when keys are provided.
- **Owner spot-check: 50 items in total** (the owner's decision), drawn across the labelled test sets in proportion to their size, at least 5 per dataset that has independent labels. Owner–labeller agreement is reported (raw agreement and Cohen's κ, with the per-dataset n). Items the owner overrules are fixed in the test split and logged.
- Estimated eval API spend for full labelling at the M5 sizes is under $30 at current small-model prices; the harness enforces the cap regardless (§1 rule 7).

## 5. Statistics

- Proportions: Wilson 95% interval.
- "Zero" gates: report `0/n` with the one-sided 95% upper bound (≈ 3/n). A "< 1%" claim needs n ≥ 300, so milestone gates make no such claim.
- nDCG@10, R@5 means: percentile bootstrap, 10,000 resamples, seed 1234.
- Comparisons between systems: paired bootstrap over queries (10,000 resamples) of the per-query difference; "A beats B" = 95% CI of the mean difference excludes 0 in A's favour.
- Stochastic suites: ≥ 3 runs; report mean and the interval over runs × items (cluster bootstrap by item).
- Result file:

```json
{"suite":"R","system":"memory-anywhere","dataset":"longmemeval-s-200","split":"test","labels":"public","git_sha":"…","model_id":"…","policy_version":"P1",
 "n":200,"runs":1,"metrics":{"ndcg10":{"mean":0.0,"ci95":[0.0,0.0]},"r5":{"mean":0.0,"ci95":[0.0,0.0]}},
 "per_category":{},"comparisons":[{"vs":"bm25","metric":"ndcg10","diff":0.0,"ci95":[0.0,0.0]}],
 "eval_spend_usd":0.0,"started_at":"…","duration_ms":0}
```

`labels` is `public`, `family-<C>` or `author`.

## 6. Policy release gate

A new policy version Pn+1 is accepted only if, on suite P server stage and the Claude Code headless model-stage run:
- secret and sensitive "zero" gates still hold;
- stored precision does not drop by more than 2 points and stored recall by more than 2 points versus Pn (paired bootstrap; CI of the difference must not exclude a 2-point loss);
- section placement accuracy does not drop by more than 2 points.

## 7. Baselines

| System | How | When |
| --- | --- | --- |
| none | No memory | M1 |
| BM25-only | FTS5 `bm25()` over content + excerpt + aliases | M0 |
| vector-only | Brute-force cosine with the pinned model | M0 |
| memory-anywhere | Full system; also no-LLM mode | M1 |
| mem0 OSS | Local docker, its MCP or Python API through `adapters/mem0.ts` | M5 report |
| mcp-memory-service | Local SQLite backend, its MCP tools through `adapters/mcp-memory-service.ts` (12.7.0 as of Nov 7 2026; pinned when the adapter is built) | M5 report |
| Vendor native memory | Manual rows only (Claude, ChatGPT memories) in suites A and X | M4 |

mem0 OSS and mcp-memory-service stay in the benchmark (owner decision); only their timing moves to the M5 report.

## 8. Harnesses

### 8.1 Adapter contract

```ts
interface MemoryAdapter {
  name: string;
  reset(): Promise<void>;                                   // empty store
  save(fact: { content: string; kind?: string; entity?: string; attribute?: string;
               valid_from?: string; user_words?: string; supersedes?: string },
       ctx: { client: string; session: string; at: string }): Promise<{ id?: string; outcome: string }>;
  recall(query: string, k: number, ctx: { client: string; as_of?: string }): Promise<{ id: string; content: string; score?: number }[]>;
  forget(id: string): Promise<void>;
  capabilities(): { supersede: boolean; bitemporal: boolean; outcomes: boolean };
}
```

Adapters map to each server's own tools (for example mem0 `add_memories`, `search_memory`). Suites skip metrics a system's `capabilities()` cannot support and report them as n/a.

### 8.2 Chat-app models through APIs (optional, eval keys and cap)

| Vendor | Mechanism | Notes |
| --- | --- | --- |
| Anthropic | Messages API MCP connector (`mcp_servers` with `authorization_token`, one `mcp_toolset`), beta header recorded in M0 | Tools only; the harness obtains the token itself; server must be public https ([MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)). Server instructions are not documented as passed, so the harness also runs a variant with them in the system prompt |
| OpenAI | Responses API `mcp` tool (`server_url`, `authorization`, `require_approval: "never"`, `allowed_tools`) ([MCP tool](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)) | |
| Google | Gemini API with the harness as the MCP client (it lists tools, passes them as function declarations, executes calls against the server) | M0 Q18 confirms the approach if a Google key is provided; app behaviour checked manually |
| xAI | Same pattern as Google if M0 Q11 shows Grok's API supports function calling with the needed models | manual only otherwise |

API tokens for eval stacks: the harness runs the normal authorization code flow once against the eval stack's pairing window, using a virtual WebAuthn authenticator in Playwright for the eval stack's own passkey, and caches the refresh token. This browser-automation dependency is used only for M2-and-later eval-stack runs, never against `prod`.

API results and app results are reported separately; a short dated manual checklist confirms the apps behave like the APIs.

### 8.3 Coding tools (the no-key path)

- Claude Code: `claude -p` in a generated fixture directory with `--setting-sources user` (a temp user settings dir), `--mcp-config <file> --strict-mcp-config`, `--settings '{"disableAllHooks": false}'` with only the memory-anywhere hooks under test configured, and `--allowedTools "mcp__memory-anywhere__*"`. Without `--bare` it uses the owner's subscription, so it needs no API key. `-p` runs project hooks and `.mcp.json` even in untrusted folders and starts in Manual permission mode; `claude mcp login` cannot run in `-p` ([headless](https://code.claude.com/docs/en/headless)), so the harness uses the stdio proxy with a pre-provisioned eval token. Flag behaviour is verified in M0 Q12. This is also how the Claude rows of suites A, P (model stage) and S (model-driven) run.
- Codex: `codex exec --json` with a temp `CODEX_HOME`.
- Cursor: `agent -p --output-format json --approve-mcps` with a temp config dir; hooks in the CLI are undocumented, so Cursor capture is tested only in the IDE manually.
- Evals never run inside a cloned third-party repository.

## 9. Commands

```
pnpm eval run --suite R --system memory-anywhere --dataset evals/datasets/public/longmemeval-s-200 --split test --runs 1 --out docs/results/2026-11-20-R-memory-anywhere.json
pnpm eval calibrate dup --dataset evals/datasets/w --split dev
pnpm eval report --in docs/results --out docs/results/report.md
```

## 10. Milestone gates (summary)

| Milestone | Suites that must pass (all without eval keys) |
| --- | --- |
| M0 | R baselines (BM25, vector, each candidate model) print with CIs on the LongMemEval-S 200-question test subset; the model is chosen on the dev subset |
| M1 | W gate; R gate on the LongMemEval-S subset; P server-stage gates; C local; all unit/property/contract tests on 4 runners |
| M2 | R gate on full LongMemEval-S retrieval; P model stage (Claude Code headless) reported; A reported; X for supported pairs; S deterministic families all pass and model-driven ASR baseline recorded; C remote |
| M3 | I gates; W capture items; S-POI-09 |
| M4 | S full re-run (red-team pass adds ≥ 30 new cases); X full matrix incl. phones; restore drill |
| M5 | Report: every suite at full size, mem0 and mcp-memory-service baselines, CIs, ablation, negative results; cross-vendor rows where eval keys were provided |
