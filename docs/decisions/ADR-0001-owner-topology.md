# 0001 Owner topology: one AWS store, a thin PC client

Status: accepted
Date: 2026-11-07
Milestone: M1–M2

## Context
v2 said both "local by default" and "AWS from day one", and gave the PC daemon the database and model (review2-architecture N1, contradictions 1–3, 25). The owner decided the store lives on AWS from day one; local mode must remain for other users.

## Options
1. PC daemon as store, AWS as tunnel target: two stores or a sync problem.
2. AWS store; the PC runs only a pure-JS client (proxy, hooks, spool, caches); local mode is the same server bound to 127.0.0.1.

## Decision
Option 2. The owner's PC holds no database, no model and no LLM key. Projections are pulled by the client. M1 runs local mode with throwaway data; the owner's real store starts empty in M2. Spec: topology-and-ipc.md §1–2.

## Consequences
One store, one write path. Coding tools depend on the network at session start; offline they use caches and the spool. Local mode is a supported, separately gated configuration.
