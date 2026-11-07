# 0009 No memory content in repositories or instruction files; optional projections deferred

Status: accepted
Date: 2026-11-07 (revised in round 3)

## Context
v2 projected into Claude Code's autoMemoryDirectory, a repo AGENTS.md block and an alwaysApply Cursor rule (review2-architecture N11; review2-security E7, H3, H4, A4; factcheck rows 39–40). These leak into git, collide with native memory, and turn data into instruction files. Codex `memories_extensions` is undocumented.

## Decision
Coding tools get memory through the session-start hook, with the client's cache as the offline fallback. No projection file is written outside the client's data directory. The optional user-level files of the first v3 draft (a Claude Code rules file, a managed block in `~/.codex/AGENTS.md`) and their managed-block hash machinery are deferred until the session-start hook proves insufficient in use (round-3 audit, over-engineering item 7; ADR-0023). Cursor gets a policy-only rule in enabled repos, git-excluded; an existing file not written by this client is left untouched. Spec: clients.md §5.

## Consequences
If the network is down at session start and no cache exists yet, the session starts without memory. Memory never reaches a commit through this project.
