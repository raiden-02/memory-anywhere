# 0103 Claude custom connector and tool loading

Status: accepted (static credentials; tool loading is account-wide)
Date: 2026-11-09
Milestone: M0
Question: Q04, Q08

## Context
- **Q04.** Claude web, desktop and mobile reach memory-anywhere through one custom connector added on claude.ai. Q04 asks whether
  static client credentials entered in that dialog work with the OAuth library. If not, the fallbacks are CIMD and then DCR.
  The redirect is `https://claude.ai/api/mcp/auth_callback` in every case.
- **Q08.** Claude can keep a connector's tools loaded or load them on demand. Q08 asks whether a per-connector default exists, so
  that `mema init` could print the steps.

## Options
- **Q04:** static confidential client; CIMD; DCR inside the pairing window.
- **Q08:** print per-connector steps; or document the account-level setting and let eval suite A measure both modes.

## Method
- **Q04:** spike release 0.0.1-m0.5.
  - A pairing window for Claude, method static.
  - The connector was added with the window's OAuth Client ID and Secret (Advanced settings), on claude.ai and in the Claude
    Desktop app on Windows (same account).
  - The owner approved consent with the passkey.
  - Save and recall were tested on web and desktop; Claude mobile was asked "What is my test planet?".
- **Q08:** claude.ai settings and the connector page, explored in the owner's Chrome. Then four fresh chats compared the two
  loading modes, with and without the custom instruction.

## Result
Evidence: [`docs/results/evidence/ADR-0103/claude-desktop-windows.md`](../results/evidence/ADR-0103/claude-desktop-windows.md).
- **Static credentials work:**
  `grant_created vendor=claude redirect_uri=https://claude.ai/api/mcp/auth_callback`.
- **The connector reaches every Claude surface on the account.**
  - Claude Desktop: `memory_save` wrote `Test color is teal`.
  - Claude Code: the connector appeared with no setup.
  - Claude web: saved and recalled.
- **Mobile:** see the *Mobile* section below (owner's phone check).
- **Q08 tool loading is account-wide.** Settings → Capabilities → Advanced → "Connectors in new chats" offers "Only when a chat
  needs them" (the default) and "At the start of every chat".
- **Per connector**, only Tool permissions exist: Needs approval / Always allow / Blocked.
- **The custom instruction alone is enough** for unprompted save and recall in either loading mode (runs 2–4). Without it, Claude's
  own memory takes "remember…" (run 1).

### Mobile
Pending the owner's phone check ("What is my test planet?" in the Claude app). Recorded here when done.

## Decision
- **Q04:** static confidential client, redirect `https://claude.ai/api/mcp/auth_callback`. CIMD and DCR are not needed for Claude.
- **Q08:**
  - `mema init --print-custom-instruction` prints the claude.ai steps: Settings → Your Claude → Instructions (ADR-0104), and Tool
    permissions → Always allow on the connector.
  - "Connectors in new chats" is left at its default. It is account-wide and costs context in every chat, and the instruction
    makes it unnecessary.
  - Eval suite A records which mode was set.
- **Spec change:** clients.md §4 names the account-wide setting instead of a per-connector default.

## Consequences
- **One connector serves all Claude surfaces.** The duplicate inside Claude Code is handled by ADR-0105.
- **Instructions must come from elsewhere.** Server instructions do not reach the model through this connector (ADR-0104), so the
  custom instruction and the tool descriptions carry the policy.
- **Saved text can carry pronouns.** One save produced "His test city is Lisbon". memory-policy.md §6 gains a pronoun-free rule
  for `memory_save` text in M1 (negative-results.md).
