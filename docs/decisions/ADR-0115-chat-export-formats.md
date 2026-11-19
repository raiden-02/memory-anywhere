# 0115 Chat export formats the history importers rely on

Status: accepted (Claude: from a real export; ChatGPT: from the documented shape, pending a real export)
Date: 2026-11-15
Milestone: M3

## Context
importers.md §3 asks that the role field and structure of each history export be checked against a real export at the start
of M3, recorded as synthetic fixtures in `evals/datasets/i/`, and any difference written down in an ADR. The parsers
(`packages/importers/src/sources/claude-history.ts`, `chatgpt-history.ts`) read only the fields below, and read them
tolerantly: a field that is missing or of another type is skipped, never guessed. This ADR records the field names only; no
owner content is kept.

## Options
1. Parse the whole export, attachments included: more facts, but pasted files are documents, not the owner's words
   (importers.md §3), and they are where injected text would hide.
2. Parse only the owner's own messages from `conversations.json`, by the fields below. Chosen.

## Result
**Claude** (data export started from Settings > Privacy; checked against the owner's real export, 2026-11-15):
- The download is a data export manifest with **separate ZIP parts per category**; the conversations are in their own part.
  Download links are **single use**.
- `conversations.json` is an array of conversations: `uuid`, `name`, `created_at`, `chat_messages[]`.
- Each message: `uuid`, `sender` (`human` | `assistant`), `text`, `created_at`, and `content[]` of `{type, text}` parts. The
  parser uses `text`, and the `content[]` parts of `type: "text"` when `text` is empty.
- Only `sender: "human"` messages are the owner's words. `attachments` and `files` are ignored.

**ChatGPT** (Settings > Data controls > Export; **from the documented shape, pending the owner's real export**):
- `conversations.json` is an array of conversations: `conversation_id` (or `id`), `title`, `create_time` (seconds),
  `current_node`, `mapping`.
- `mapping` is a tree keyed by node id; each node has `id`, `parent`, `children`, `message`. A message has `id`,
  `create_time`, `author.role` (`user` | `assistant` | `system` | `tool`), `content.content_type` and `content.parts[]`.
- An edited or regenerated message starts a new branch. Only the branch from `current_node` up to the root is read: the
  conversation as the owner last saw it. Without `current_node`, every node in time order.
- Only visible `user` messages of type `text` or `multimodal_text` are the owner's words; string `parts` are joined, other parts
  (images, files) skipped. A message marked `metadata.is_visually_hidden_from_conversation` (custom instructions) is not read.

Fixtures: `evals/datasets/i/imports/claude-history.conversations.json` and `chatgpt-history.conversations.json` (persona Alex,
synthetic), with a regenerated branch, a tool message and a hidden message in the ChatGPT one.

## Decision
The importers read the fields above and nothing else; the history rows of importers.md §2 point here. When the owner's real
ChatGPT export arrives, it is checked against this list and the fixture; any difference changes the parser, the fixture and
this ADR together.

## Consequences
- A vendor renaming a field makes the parser skip it, so the import report shows fewer messages instead of wrong ones.
- Claude's multi-part download needs the conversations part only; the other parts are never read.
- ChatGPT's abandoned branches are never imported, so a fact the owner edited away does not come back.
