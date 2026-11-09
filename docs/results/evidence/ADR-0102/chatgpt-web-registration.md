# Q03 ChatGPT registration, chatgpt.com on Windows (Chrome), ChatGPT Plus, 2026-11-09 (UTC)

Driven by Claude Code in the owner's Chrome, at the owner's request; the owner approved the passkey prompts.

## Where custom MCP servers are added
- Settings → Connectors is now **Plugins** (`chatgpt.com/settings/plugins-settings`, "Manage your plugins, connected accounts,
  and permissions"). No separate Developer mode toggle was found.
- **chatgpt.com/plugins → Add → "Add custom MCP server"**. The menu items are: Create plugin, Upload plugin archive, Add custom MCP server.
- The dialog has these fields: Icon, Name, Description, Connection (**Server URL** | **Tunnel**), Authentication (OAuth | No authentication |
  OAuth or no authentication), "Advanced OAuth settings", the risk acknowledgement "I understand and want to continue", and the button
  "Create as a plugin".

## What ChatGPT discovered from the spike (auto-filled after typing the server URL)
- **Registration method:** CIMD (Client Identifier Metadata Document) by default. The options are **User-Defined OAuth Client**,
  **Dynamic Client Registration (DCR)** and **CIMD**.
- **Callback URL:** `https://chatgpt.com/connector_platform_oauth_redirect`
- **CIMD client metadata URL:** `https://chatgpt.com/oauth/client.json`
- **Scopes:** memory.read and memory.write ticked. Base scopes empty, so no `offline_access`.
- **Endpoints:**
  - Auth URL `https://spike.{host}/oauth/auth`
  - Token URL `.../oauth/token`
  - Registration URL `.../oauth/reg`
  - Authorization server base `https://spike.{host}`
  - Resource `https://spike.{host}/mcp`
- **OIDC:** "OIDC enabled" ticked, with OIDC configuration URL `https://spike.{host}/.well-known/openid-configuration` and
  scopes supported memory.read, memory.write, memory.capture, offline_access.
- **User-Defined OAuth Client fields:** OAuth client ID, OAuth client secret, and Token endpoint auth method (none | client_secret_basic |
  client_secret_post). We used `client_secret_basic`.

## Result: static credentials work
Static credentials were the first method tried, so CIMD and DCR were not needed.

Server log (`journalctl -u memory-anywhere`), with client ids shortened:
```
2026-11-09T02:48:50Z {"event":"grant_created","vendor":"chatgpt","client_id":"ma_IRll…","redirect_uri":"https://chatgpt.com/connector_platform_oauth_redirect"}
2026-11-09T02:58:54Z {"event":"grant.error","error":"invalid_grant","description":"grant request is invalid"}
2026-11-09T16:07:23Z {"event":"grant_created","vendor":"chatgpt","client_id":"ma_KD08…","redirect_uri":"https://chatgpt.com/connector_platform_oauth_redirect"}
```
- **02:58 failure.** ChatGPT omits `offline_access`, so release 0.0.1-m0.5 bound its tokens to the 10-minute consent session.
  ChatGPT then showed "Your memory-anywhere spike connection has expired. Reconnect it…".
- **Fix.** Release 0.0.1-m0.6 sets `expiresWithSession: false` and adds conformance test 11c (see negative-results.md).
- **16:07 grant.** This connection was made on 0.0.1-m0.6.
