# 0005 Embedding model

Status: proposed (decided in M0 Q14)
Date: 2026-11-07

## Context
One pinned local ONNX model on every target. Candidates: EmbeddingGemma-300m (q8/q4 only; prefixes required; Gemma terms), bge-small-en-v1.5 q8, e5-small-v2 q8 (review2-architecture N19, review2-factcheck rows 25–27, M0.5).

## Decision rule
Highest hybrid nDCG@10 on the LongMemEval-S 100-question **dev** retrieval subset (public labels; evals.md §3.2; the test subset only reports the result) among models with query p95 ≤ 150 ms on the owner's PC and ≤ 400 ms on t4g.small, server RSS ≤ 700 MB on t4g.small, and a licence that allows on-demand download with notice. Ties (paired CI includes 0): smaller model. Runtime: onnxruntime-node with @huggingface/tokenizers, no transformers.js.

## Consequences
`models.json` records repo, revision SHA, file SHA-256, dtype, dims, pooling and prefixes. Thresholds are calibrated for this model.
