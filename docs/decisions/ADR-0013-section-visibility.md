# 0013 Per-client section allow-lists; Projects visible to Claude chat, restricted fields CLI-only

Status: accepted
Date: 2026-11-07

## Context
The security review proposed Projects readable only by coding tools in the matching repo and per-client section allow-lists, e.g. Gemini limited to Profile, Preferences and Interests (E1, E4). The owner uses Claude mobile as the primary phone app and wants project context there (career-os, portfolio decisions).

## Decision
Each client has a section allow-list. Claude (web, desktop, mobile) and ChatGPT: all sections. Gemini, Grok and generic clients: Profile, Preferences, Interests, Tools and setup, with writes floored to observation. Coding tools: everything global plus only the current repo's project. `project.repo` and `project.portfolio_relevance` are never returned by MCP to anyone; they are CLI and export only. Project names never appear in the profile.

## Consequences
Claude chat can answer project questions; an injected Claude session can read project status, goals and decisions within the read budget. Accepted.
