# Q11 Grok custom connector, grok.com on Windows (Chrome), SuperGrok ("Super"), 2026-11-09 (UTC)

Driven by Claude Code in the owner's Chrome at the owner's request. The owner filled Grok's name and age form, approved the
passkey prompts, and clicked Approve in Grok's popup. Optional cookies were rejected.

## Where and how
- **Location:** grok.com/connectors (title "Plugins") → **New Connector** → **Custom** ("Add your own custom connector") → fields
  **Name** and **Server URL** only, then "Add Connector".
- **No authentication fields** (no client id or secret, no header). The other methods in Q11's order were therefore not
  available: static OAuth credentials, CIMD, static bearer.
- **Authorization:** Grok discovers it and runs the authorization in a **popup window**.
- **Discovery (server log):**
  - `POST /mcp 401` (ua `grok-connectors-manager/0.1.0`)
  - `GET /.well-known/oauth-protected-resource/mcp 200`
  - `GET /.well-known/openid-configuration 200`: the OIDC path, not oauth-authorization-server
  - then the same again with ua `Grok`
- **Registration (DCR):** `POST /oauth/reg`. Logged request (all fields; there is no secret in a DCR request):
  ```
  {"fields":["client_name","redirect_uris","grant_types","response_types","token_endpoint_auth_method"],
   "redirect_uris":["https://grok.com/connectors-oauth-exchange-code/"],"token_endpoint_auth_method":"none",
   "grant_types":["authorization_code","refresh_token"],"client_name":"Grok"}
  ```
  Without a window: `400 invalid_request` and "Connection failed". Grok sends **no `application_type`**: spec-issues #19.
- **Authorization request** (logged at the consent page):
  `"scope":"memory.read memory.write memory.capture","resource":"https://spike.{host}/mcp"`. Grok asks for every advertised scope.
- **Token exchange:** `POST /oauth/token 200` (ua `Grok`), public client (`none`) with PKCE.

## Failures on the way (negative-results.md)
1. **0.0.1-m0.12: no window open.** DCR was refused, as designed, while we captured the request.
2. **0.0.1-m0.13: second consent.** DCR registered (201) and the owner approved (`grant_created vendor=grok`), but the provider
   opened a second consent for the same authorization and the popup showed "This request is not valid". Cause:
   `memory.capture` was requested and withheld. The 0.0.1-m0.14 change (grant a requested `openid`) did not fix it.
3. **0.0.1-m0.15: fixed.** Resource scopes now depend on the client, so `memory.capture` is dropped for vendors. Grok connected at
   17:54:31Z (`grant_created`, `POST /token 200`).

## Chats (grok.com, model "Auto", fresh chats, no custom instruction)
| # | Prompt | Reply (verbatim) | Server |
| --- | --- | --- | --- |
| 1 | "What is my test planet?" (fact only in memory-anywhere) | "Neptune. That's the one stored in your memory as your "test planet."" | tools/call memory_recall ×2, memory_status; no approval asked |
| 2 | "Remember that my test mountain is Everest." | "Got it — your test mountain is Everest. I'll remember that." | tools/call memory_save; row `"The user's test mountain is Everest."`; no approval asked |

Grok opens a new MCP session (`initialize`, `notifications/initialized`) before each tool call (ua `grok-connectors-manager/0.1.0`).
Its answers mention `search_connected_tools`, so tools are found by search: loaded on demand, but found without the prompt
naming the app.

## Other Q11 items
- **Write approval:** none was asked for memory_save (run 2).
- **Instructions:** server instructions do not pass (canary 0/3; see ADR-0104 evidence).
- **Mobile:** not yet checked.
- **xAI API function calling:** yes. docs.x.ai/docs/guides/function-calling: "Define custom tools that the model can invoke during
  a conversation" (model named: grok-4.7). The page does not mention remote MCP.
- **Q19:** Settings → Customize → "Customize Grok's Response" → **Custom** → textarea "How should Grok behave?" (no length limit
  shown). Not needed: Grok saved and recalled without it.
