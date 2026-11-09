# Q17 Disabling only the claude.ai memory-anywhere connector in Claude Code, 2026-11-09 (UTC)

## Setup
- Claude Code 2.1.319, Windows 11.
- The owner's claude.ai account has the custom connector "memory-anywhere" (the spike).
- `claude mcp list` shows it as **`claude.ai memory-anywhere`**, next to "claude.ai Claude Docs", "claude.ai Google Drive" and
  "claude.ai Gmail".

## Method
Each variant is a one-turn headless run:
```
claude -p "Reply with OK." --max-turns 1 --output-format stream-json --verbose [variant]
```
Each run is read for `mcp_servers` in the `system/init` event (claude.ai entries shown).

## Results
| Variant | claude.ai servers in the session |
| --- | --- |
| none (baseline) | Claude Docs, **memory-anywhere**, Google Drive, Gmail |
| `--settings '{"disabledMcpjsonServers":["claude.ai memory-anywhere"]}'` | unchanged (memory-anywhere still connected) |
| `--settings '{"disabledMcpServers":["claude.ai memory-anywhere"]}'` | unchanged |
| `--settings '{"deniedMcpServers":[{"serverName":"claude.ai memory-anywhere"}]}'` | Claude Docs, Google Drive, Gmail. **memory-anywhere removed**; stderr: "Warning: claude.ai MCP server blocked by enterprise policy: claude.ai memory-anywhere" |
| project `.claude/settings.json` with the same `deniedMcpServers` entry | Claude Docs, Google Drive, Gmail. **memory-anywhere removed** |

## Conclusion
- **Per-connector disable exists.** `deniedMcpServers` with `serverName: "claude.ai <connector name>"` removes only that connector,
  from a settings file as well as from `--settings`. The warning text calls it "enterprise policy" even when it comes from an
  ordinary settings file.
- **`disabledMcpjsonServers`** applies to `.mcp.json` servers only, not to claude.ai connectors (see also the earlier part of Q17
  in `claude-code-q07-q12-q13-q17.json`).
- **For `mema init`:** add `{"serverName":"claude.ai <name the owner gave the connector>"}` to `deniedMcpServers` in user settings,
  with a backup. The name is whatever the owner typed in claude.ai, so `init` reads it from `claude mcp list`.
