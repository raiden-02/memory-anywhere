# Q01 (phone, desktop) and Q04 (mobile): ChatGPT and Claude away from the PC web app, 2026-11-10 (UTC)

The owner ran the checks on their phone and on the PC. The spike server is unchanged (release 0.0.1-m0.16), with the same
connections as the web tests: ChatGPT static client `ma_KD08…`, Claude static client `ma_PSEE…`. Prompts, one fresh chat each:
"What is my test planet?", then "Remember that my test color is amber."

## Owner's report
"No issues there, at least on Claude on ChatGPT apps." The ChatGPT desktop app on the PC "also worked".

## Server log (access log; the user agents cannot tell a phone app from a desktop app)
```
00:27:18Z POST /mcp 200 tools/call:memory_recall  client ma_PSEE… ua Claude-User      <- Claude app on the phone
00:28:03Z POST /mcp 200 tools/call:memory_recall  client ma_KD08… ua openai-mcp/1.0.0 <- ChatGPT app on the phone
00:28:30Z POST /mcp 200 tools/call:memory_recall  client ma_KD08… ua openai-mcp/1.0.0
00:28:52Z POST /mcp 200 tools/call:memory_save    client ma_KD08… ua openai-mcp/1.0.0
00:29:13Z POST /mcp 200 tools/call:memory_save    client ma_PSEE… ua Claude-User
00:29:55Z POST /mcp 200 tools/call:memory_recall  client ma_KD08… ua openai-mcp/1.0.0 <- ChatGPT desktop app on the PC
```
Stub rows written:
```
{"id":"mem_749b557f9deb596d","text":"The user's test color is amber.","user_words":"Remember that my test color is amber","client":"oauth","saved_at":"2026-11-10T00:28:52.502Z"}
{"id":"mem_76fb71a1f47e1469","text":"The user's test color is amber.","user_words":"Remember that my test color is amber","client":"oauth","saved_at":"2026-11-10T00:29:13.687Z"}
```

## Result
| Surface | Recall | Save |
| --- | --- | --- |
| ChatGPT app (phone) | works | works (the 00:28:52 row) |
| ChatGPT desktop app (Windows) | works | not tried |
| Claude app (phone), connector added on the web | works | works (the 00:29:13 row) |
| chatgpt.com in the phone's browser | not reported | not reported |
| Grok app (phone) | not reported | not reported |

The phone needed no setup: each connector added on the web was already available in that vendor's phone app.
