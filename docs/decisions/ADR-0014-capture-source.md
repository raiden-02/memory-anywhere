# 0014 Capture only from the prompt hook; no transcripts, no assistant text

Status: accepted
Date: 2026-11-07

## Context
v2 captured via Stop and `last_assistant_message`, with assistant text as extractor context (review2-architecture N24; review2-security P5). All three coding tools pass the user's prompt to a hook: Claude Code and Codex `UserPromptSubmit.prompt`, Cursor `beforeSubmitPrompt.prompt` (factcheck B7, rows 42, 61).

## Decision
The only capture source is the prompt hook's prompt field, redacted on the PC. Extraction sees only those prompts; each candidate must quote a span of ≥ 8 characters from a prompt and overlap it by ≥ 0.6 of its content words. No transcript fallback: a tool without a prompt hook has no capture.

## Consequences
Facts the user states only by accepting an assistant suggestion ("yes, do that") are not captured; the model can still call memory_save. Transcript format churn no longer matters.
