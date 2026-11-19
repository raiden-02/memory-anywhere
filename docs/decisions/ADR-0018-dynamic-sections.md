# 0018 Dynamic sections are created automatically with undo; their text is not model-facing until approved

Status: accepted
Date: 2026-11-07

## Context
Owner decision: dynamic sections auto-created with undo. Security review: model-proposed names and descriptions enter the always-loaded section map (P8, D-4: proposals until approved). Architecture review: define theme detection and cap the count (N23).

## Decision
A weekly clustering job creates at most 2 sections per run (cap 16 active) from clusters of ≥ 3 Unsorted memories across ≥ 2 sessions above a cosine threshold (fixed at 0.60 until calibrated on real data after M3). The section exists at once and holds its memories (owner decision honoured), and its name (≤ 32 chars, restricted alphabet, screened) appears in the section map. Its description and aliases are used model-facing only after owner approval. Undo returns memories to Unsorted. Spec: memory-policy.md §9.2.

## Consequences
A poisoned cluster can at worst add a short, screened name to the map, visible in the admin UI and undoable.
