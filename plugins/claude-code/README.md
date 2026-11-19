# memory-anywhere for Claude Code

Gives Claude Code the user's personal memory, shared with their other AI apps.

- **Tools:** `memory_recall`, `memory_profile`, `memory_save`, `memory_forget` and `memory_status`, served by a local stdio
  proxy (`dist/memory-anywhere.mjs mcp`) that relays to the user's own memory-anywhere store.
- **Hooks:** at session start the store's context for the current repository is added; each prompt is sent (redacted) only from
  repositories the user enabled with `mema enable`, so the store can check quoted words.
- **Skill:** when to recall and when to save.

Install with `mema init`, which also sets up Codex and Cursor. Nothing is written into any repository.
