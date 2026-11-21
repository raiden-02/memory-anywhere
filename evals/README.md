# evals

The benchmark: the suites that measure memory-anywhere, and can measure any other memory server through
an adapter. What each suite tests and its gates: [evals](../docs/design/spec/evals.md). The latest
numbers: [results](../docs/results/report.md).

## The suites

Each suite asks one question a user would ask about a shared memory:

| Suite | Question | Runs against |
| --- | --- | --- |
| P | Does it save the right things, and refuse the rest? | the write path, then a real model |
| W | Does a save ever overwrite a true fact? | the write path |
| R | Does recall find what was said? (LongMemEval-S) | each system through its adapter |
| A | Does each app call the tools when it should? | Claude Code headless |
| C | Do the protocol, OAuth and latency hold? | a local server or an eval stack |
| S | Can it be attacked? | a local server, a model, an eval stack |
| I | Do imports keep the right facts? | the importers, on synthetic exports |
| X | Does a fact saved in one app show up in another? | the real apps (manual matrix) |

## Running one

No API keys are needed: every suite runs without them.

```sh
pnpm eval run --suite W
pnpm eval run --suite R --split test
pnpm eval run --suite S
```

`--out <file>` writes the JSON result; `docs/results/data/` keeps the latest per suite. Suites W, C and
I need the pinned embedding model files (`MA_TEST_MODEL_DIR`, or the download folder of
`node evals/embed/fetch-models.ts`). Suites S and C can target a deployed eval stage with
`--stack https://eval.memory.example.com --stage eval-<id> --owner <file outside the repo>`.

An eval stage runs CI-signed releases. To run your own build there (`mema deploy aws --stage eval-<id>
--release-file <tarball>`), make your own dev signing key once, in the client's data folder
(`{data}`, [config-and-cli §3](../docs/design/spec/config-and-cli.md)); your stages trust it, no one
else's do:

```sh
minisign -G -W -p "{data}/dev-release.pub" -s "{data}/dev-release.key"
```

## Folders

| Path | What it is |
| --- | --- |
| `harness/` | The CLI (`cli.ts`), one file per suite, statistics and the fake LLM |
| `adapters/` | One adapter per system under test (memory-anywhere, BM25) |
| `datasets/` | Hand-written cases per suite, and fetch scripts for the public sets (LongMemEval-S, MemoryAgentBench) |
| `embed/` | The embedding-model benchmark that chose the pinned model |
| `fixtures/`, `test/` | Fixtures and the harness's own tests |
