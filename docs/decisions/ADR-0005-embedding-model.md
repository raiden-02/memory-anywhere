# 0005 Embedding model

Status: accepted (M0 Q14: EmbeddingGemma-300m q4)
Date: 2026-11-07

## Context
One pinned local ONNX model on every target. Candidates: EmbeddingGemma-300m (q8/q4 only; prefixes required; Gemma terms), bge-small-en-v1.5 q8, e5-small-v2 q8 (review2-architecture N19, review2-factcheck rows 25–27, M0.5).

## Decision rule
Highest hybrid nDCG@10 on the LongMemEval-S 100-question **dev** retrieval subset (public labels; evals.md §3.2; the test subset only reports the result) among models with query p95 ≤ 150 ms on the owner's PC and ≤ 400 ms on t4g.small, server RSS ≤ 700 MB on t4g.small, and a licence that allows on-demand download with notice. Ties (paired CI includes 0): smaller model. Runtime: onnxruntime-node with @huggingface/tokenizers, no transformers.js.

## Consequences
`models.json` records repo, revision SHA, file SHA-256, dtype, dims, pooling and prefixes. Thresholds are calibrated for this model.

## Update 2026-11-08: M0 Q14 result

Question: Q14.

### Method
- `spikes/embed-bench` (onnxruntime-node 1.31.1 + @huggingface/tokenizers 0.2.0, no transformers.js). Candidates pinned to Hugging Face commits: `onnx-community/embeddinggemma-300m-ONNX@5090578d` (`model_quantized.onnx` = q8, `model_q4.onnx` = q4), `Xenova/bge-small-en-v1.5@ea104dac` and `Xenova/e5-small-v2@02af7998` (`model_quantized.onnx` = q8). Each model card's prefixes and pooling; every model capped at 512 tokens per input. File SHA-256s recorded on the PC and re-checked on the instance.
- Quality: the LongMemEval-S 100-question **dev** subset (evals/datasets/public/longmemeval-s/split.json), rounds as documents; vector = top 50 by dot product; hybrid = RRF (k = 60) of the BM25 top 50 and the vector top 50 (retrieval.md §2); nDCG@10 and R@5 with percentile-bootstrap CIs and paired bootstrap for comparisons (10,000 resamples, seed 1234). Document vectors computed with DirectML on the owner's RTX 4080 SUPER and cached; queries on CPU. Control: bge-small's dev corpus also embedded on CPU (hybrid 0.722 vs 0.725 on GPU; CPU/GPU cosine ≥ 0.996 for every model, ≥ 0.9997 for EmbeddingGemma).
- Latency and memory, CPU only, each candidate in a fresh process holding only the model and a 10,000-vector store: embed each of the 100 dev queries and score it against the store. Owner's PC: Windows 11, i9-14900KF, Node 24.22.2. Spike instance: t4g.small (2 vCPU Neoverse-N1, 1.8 GB), through SSM Run Command.
- Install: onnxruntime-node 1.31.1 installed with lifecycle scripts disabled and loaded on Windows x64 and linux-arm64; its package carries the prebuilt binaries for every platform (294 MB unpacked; the release keeps only linux-arm64).
- Evidence: [`q14-pc-dev.json`](../results/evidence/ADR-0005/q14-pc-dev.json), [`q14-pc-dev-bge-cpu-control.json`](../results/evidence/ADR-0005/q14-pc-dev-bge-cpu-control.json), [`q14-t4g-small.txt`](../results/evidence/ADR-0005/q14-t4g-small.txt), [`q14-pc-test.json`](../results/evidence/ADR-0005/q14-pc-test.json), and the suite R result file [`2026-11-08-R-baselines-test.json`](../results/2026-11-08-R-baselines-test.json).

### Result (dev, used for the choice; BM25 0.735)
| Candidate | Hybrid nDCG@10 | Vector nDCG@10 | p95 PC (≤ 150 ms) | p95 t4g.small (≤ 400 ms) | RSS t4g.small (≤ 700 MB) | Eligible |
| --- | --- | --- | --- | --- | --- | --- |
| EmbeddingGemma-300m q8 | 0.751 [0.701, 0.800] | 0.744 | 177 ms | 385 ms | 1,497 MB | no (PC latency, RSS) |
| **EmbeddingGemma-300m q4** | **0.760 [0.709, 0.809]** | 0.734 | 68 ms | 158 ms | 444 MB | yes |
| bge-small-en-v1.5 q8 | 0.725 [0.668, 0.780] | 0.666 | 21 ms | 58 ms | 183 MB | yes |
| e5-small-v2 q8 | 0.730 [0.678, 0.779] | 0.667 | 21 ms | 57 ms | 186 MB | yes |

Paired hybrid differences on dev: q4 − e5 = +0.030 [0.003, 0.060], q4 − bge = +0.035 [0.008, 0.066]: not ties.

Test subset (reporting only, 200 questions, answerable n = 188): BM25 0.718 [0.675, 0.761]; hybrid q4 0.746 [0.709, 0.783], +0.028 [0.005, 0.050] over BM25; hybrid q8 0.750; hybrid e5 0.711 and bge 0.710, neither above BM25 (−0.007, −0.008). Vector-only: q4 0.725, q8 0.728, bge 0.623, e5 0.613.

### Decision
**Accepted: EmbeddingGemma-300m q4** (`onnx-community/embeddinggemma-300m-ONNX@5090578d`, `onnx/model_q4.onnx` + external data, 768 dims, the export's `sentence_embedding` output, query prefix `task: search result | query: `, document prefix `title: none | text: `, 512 tokens), recorded with file hashes in `config/models.json`. It has the highest hybrid nDCG@10 among the models that meet every limit, and wins over the two small models by a paired CI that excludes 0. Licence: Gemma Terms of Use, which allow on-demand download with the terms and a notice (the client shows them before downloading). onnxruntime-node needs no install script (pnpm `allowBuilds: onnxruntime-node: false`; spec-issues.md #15).

### Consequences
`abstain_cosine` and the other similarity thresholds are calibrated for this model in M1 on the dev subset. The t4g.small query p95 of 158 ms leaves headroom under the 400 ms limit but is ~2.5× the small models'; the server should keep the model loaded (no per-request load) and embed writes off the request path. RSS 444 MB fits the t4g.small next to the server; `t4g.micro` (1 GiB) is not an option with this model. The small models lose to BM25 alone on hybrid here, recorded in negative-results.md.
