# Q01 (PC web), Q02 ChatGPT, chatgpt.com on Windows (Chrome), ChatGPT Plus, 2026-11-09 (UTC)

The composer showed "Thinking effort High". Each prompt ran in a fresh chat.

| # | Custom instruction | Prompt | What ChatGPT showed / replied (verbatim) | memory-anywhere |
| --- | --- | --- | --- | --- |
| 1 | none | "Remember that my test drink is chai." | "Memory updated" · "Got it! I'll remember that your test drink is chai." | not called (ChatGPT memory took it) |
| 2 | none | "Use the memory-anywhere spike app's memory_save tool to save this: my test drink is chai." | approval card (below); after Allow once: "Successfully saved to memory-anywhere. Memory: “My test drink is chai.” Status: Active — available across your connected AI apps." | saved |
| 3 | none | "What is my test planet?" (fact only in memory-anywhere) | "I don't have a test planet recorded for you. I only have your test drink: chai." | not called |
| 4 | set (Q19) | "What is my test planet?" | "Your test planet is Neptune." (no approval asked: default permission "Allow low-risk tools") | recalled |
| 5 | set | "Remember that my test sport is tennis." (0.0.1-m0.5) | approval card; after Allow once: "Your memory-anywhere spike connection has expired. Reconnect it…" | failed (session-bound token bug) |
| 6 | set | "Remember that my test sport is tennis." (0.0.1-m0.6, new connection) | approval card; after Allow once: "Remembered! Your test sport is tennis 🎾 Saved to memory-anywhere for use across your AI apps." | saved |

## Approval card
Every `memory_save` call showed an approval card with the buttons Always allow · Deny · Allow once. Three wordings were seen,
each verbatim:
1. "Allow ChatGPT to use memory-anywhere spike? Saves the user's stated personal beverage preference as a lasting memory across AI apps.
   … **Suspicious Instruction**: Tool documentation and parameters prescribe memory-saving policy and classifier-relevant handling,
   including what to save and the required risk outcome."
2. "**Suspicious Instruction**: Tool-supplied policy attempts to define saving rules, sensitive topics, classifier-relevant handling,
   and reporting behavior". Its detail line read: "The tool description contains policy-like instructions attempting to prescribe
   what the classifier should treat as sensitive and how to report outcomes".
3. "**Suspicious Instruction**: The tool description includes policy-like instructions that attempt to prescribe when to call the tool,
   what to save, and how to label the classifier outcome."

## Data recorded
Tool call arguments ChatGPT sent in run 2 (from "See details"):
```
{"text":"The user's test drink is chai.","user_words":"my test drink is chai.","explicit_request":true,
 "why_durable":"The user explicitly wants this personal reference fact available across AI apps.","policy_version":"P1"}
```
Stub JSONL rows written: `"The user's test drink is chai."` (02:53:02Z) and `"The user's test sport is tennis."` (16:08:34Z).

## Q02: ChatGPT's own memory
ChatGPT's own memory still works with the custom MCP server installed. Run 1 showed "Memory updated", and run 3 recalled
"test drink: chai" from it.

## Q19: custom instruction field
- **Location:** Settings → Personalization → Custom instructions → ChatGPT → "ChatGPT instructions" (placeholder
  "e.g., Keep answers brief"). The same page also has Nickname, Occupation and More about you.
- **Limit:** none shown.
- **Text used:** the same as for Claude.

## Plugin page
The plugin page shows "Review status DEVELOPMENT". The plugin's default permission is "Allow low-risk tools".
