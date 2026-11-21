# 03 · Connect apps

At the end of this chapter Claude, ChatGPT, Gemini, Grok, Cursor, Claude Code and Codex all read and
write the same store, each with its own permission that you can take back.

Chat apps reach the store over the internet, so they need it running in your own AWS account
([04](04-your-own-aws.md)), at an address such as `https://memory.example.com`. If it is not deployed
yet, read 04 first and come back. Coding tools work with either that store or local mode
([02](02-local-mode.md)).

## 1. Two roads into the store

Think of the store as a building with two entrances. Visitors from outside come through the front door,
each with a badge of their own. People already inside the building take the inner stairs, past one
doorman who holds the building's key:

```
 vendor clouds (the internet)                                  your server
 claude.ai ──┐
 ChatGPT ────┤  each app holds its own grant                ┌─▶ https://memory.example.com/mcp
 Gemini ─────┼──────────────────────────────────────────────┤        ▣ store
 Grok ───────┘                                              │
                                                            │
 your PC                                                    │
 Claude Code ──┐                                            │
 Codex ────────┼── stdio ──▶ mema mcp ── this PC's grant ───┘
 Cursor ───────┘
```

What is really going on:

- **Chat apps** call tools from the vendor's servers, not from your phone or browser. When you chat
  with Claude on your phone, it is claude.ai's servers that call your store. Each app receives a
  **grant**: a permission for that one app, with its own limits, which you can revoke on its own.
- **Coding tools** start a small helper on your PC, `mema mcp` (the **stdio proxy**: it talks to the
  tool through standard input and output, and to the store over the network). The proxy uses this PC's
  grant, which `mema login` creates once.

## 2. The standard path any app takes

Every chat app connects the same way. The pieces:

- **MCP server URL:** your host plus `/mcp`, for example `https://memory.example.com/mcp`.
- **OAuth:** the standard way an app asks for permission to act for you. The app sends you to the
  store's own page, you approve there, and the app receives a token it can renew. You never type a
  password into the app.
- **The pairing window** ([01 §8](01-how-it-works.md)): the store accepts a new app only inside a
  10-minute window you open, for one app, once.
- **Your passkey** ([01 §9](01-how-it-works.md)) approves the connection on the store's consent page.

The whole connection fits inside the window:

```
 admin page              your browser       the app                       consent page
 ──●──────────────────────────●───────────────────●─────────────────────────────●──────────▶ time
   open a window              open the pair       add the connector,            approve with
   (passkey)                  link here           click Connect                 your passkey: connected
   │◀─────────────────────────── at most 10 minutes ────────────────────────────▶│ window closes
```

The steps, for any app:

1. Open `https://admin.memory.example.com` and sign in with your passkey. Go to **Apps**. Under
   **Connect an app**, pick the **App** and **How it registers** (§3 says which for each app), then
   click **Open a 10-minute pairing window**.

   You see: **Server URL**, **Pairing code**, **Open this link in this browser first**, and for some apps
   a **Client ID** and **Client secret (shown once)**, and the time the window **Closes**.

2. Open the link under **Open this link in this browser first**, in the same browser. This ties the
   window to your browser, so the consent page knows it is you. If the app's sign-in later opens in
   another browser or on your phone, the consent page asks for the **Pairing code** instead.

3. In the app, add a connector with the Server URL (and the Client ID and secret where the app asks for
   them), and click its connect button.

4. The consent page on `memory.example.com` opens. Check the app's name and the address it will send you
   back to, then answer "Did you just click Connect in <app> yourself?" with **Approve with passkey**.

5. Back in the app, ask: "What does memory_status say?" It answers with the store's status, and the
   app appears under **Connected apps** on the Apps page.

6. Paste the **custom instruction** where the app has a place for one (§3 says where). Chat apps do not
   pass the store's own instructions to their model, so this short
   text is how the model learns to save lasting facts and to check memory first. Print the current text:

   ```shell
   mema init --print-custom-instruction
   ```

   It prints one text for Claude, ChatGPT and Grok, and a plainer one for Gemini, which refuses text that
   names tools.

Each app has at most one connection. To connect an app again (a new phone, an expired connection), tick
**Replace its current connection** when you open the window: the old grant is revoked when the new one
is issued.

## 3. App by app

| App | How it registers | Custom instruction |
| --- | --- | --- |
| Claude | Client id and secret | yes |
| ChatGPT | Client id and secret | yes |
| Gemini | Client id and secret | yes, the Gemini text |
| Grok | The app registers itself | not needed |
| Claude Code, Codex, Cursor | this PC's grant (`mema login`) | no: the plugins carry it |

### Claude (web, desktop, phone)

1. Open a window for **Claude**, **Client id and secret**.
2. On claude.ai: **Customize → Connectors → Add custom connector**. Give it a name, paste the Server URL,
   and under **Advanced settings** the **OAuth Client ID** and **Client Secret**. Connect, then approve on
   the consent page.
3. Optional: on the connector, set **Tool permissions** to **Always allow**, so saves do not ask each time.
   Forgetting still asks every time.
4. Paste the custom instruction in **Settings → Your Claude → Instructions**.

The desktop and phone apps use the same connector from your account; do not add it again there. Claude
Code also sees connectors added on claude.ai; `mema init` blocks that copy so the tools appear once, and
Claude Code then reports it as "blocked by enterprise policy", which is intended.

### ChatGPT

Needs ChatGPT Plus with Developer Mode on.

1. Open a window for **ChatGPT**, **Client id and secret**.
2. On chatgpt.com/plugins: **Add → Add custom MCP server**. Paste the Server URL, choose **OAuth**, then
   **Advanced OAuth settings → User-Defined OAuth Client**, and paste the Client ID and secret (sent as
   `client_secret_basic`). Connect, then approve on the consent page.
3. Paste the custom instruction in **Settings → Personalization → Custom instructions → ChatGPT
   instructions**.

ChatGPT shows an approval card before a save; you can choose **Always allow**. The ChatGPT phone app
uses the connector once it is added on the web. The same connector also appears in Codex as
`codex_apps` tools, next to the Codex plugin's own.

### Gemini

Needs a personal Google account, in the US, 18 or older, in English, with **Keep Activity** on. Only the
**3.1 Pro** model calls the tools, and Gemini asks before every tool call, reads included.

1. Open a window for **Gemini**, **Client id and secret**.
2. On gemini.google.com: **Settings → Developer Mode → Choose an app → Create new → Connect to an MCP
   server**. Paste the Server URL, and under **Additional settings** the Client ID and secret.
3. Finish with **Save your custom app → Connect**, then approve on the consent page. Do not leave the page
   before the save dialog: the connection would exist on your store, but Gemini would not keep the app.
4. Paste the Gemini custom instruction in **Settings → Personal Intelligence → Instructions for Gemini**
   (gemini.google.com/saved-info, at most 3,000 characters).

Gemini may pass content from your email and connected apps, other people's messages included, into what
it saves. So by default it reads only Profile, Preferences, Interests and Tools, and its saves start as
[observations](01-how-it-works.md). The Apps page can change both.

### Grok

1. Open a window for **Grok**, **The app registers itself** (Grok's dialog takes only a name and a URL).
2. On grok.com/connectors: **New Connector → Custom**. Enter a name and the Server URL, authorize in
   Grok's popup, then approve on the consent page.

Grok needs no custom instruction and asks no approval before saving. Its phone app uses the connector added on grok.com. Like
Gemini, it reads the narrower set of sections and its saves start as observations.

### Claude Code, Codex and Cursor

The coding tools share one grant for this PC, created once:

1. Install the command line tool:

   ```shell
   npm install -g memory-anywhere
   ```

2. Set the PC up:

   ```shell
   mema init
   ```

   It asks for your store's URL (`https://memory.example.com`) and your deny-list (Git hosts where memory
   must never be used), shows each change as a diff, and asks `Make these changes? [y/N]`. After `y` it
   signs the PC in and prints:

   ```
   First open a pairing window: admin UI → Apps → App "PC", computer name "<this computer>".
   Login code: <8 characters>  (the approval page must show the same code)
   ```

3. On the admin page, open a window for **PC** with that computer name. The browser opens the approval
   page; check it shows the same login code, and approve with your passkey. `init` continues with
   `signed in to https://memory.example.com`, installs the plugins and runs `mema doctor`.

4. Do what the `next:` lines say: in Codex, trust the two memory-anywhere hooks in `/hooks` (CLI) or
   Settings → Hooks (desktop), again after each plugin update; in Cursor, run **Developer: Reload
   Window**. The Codex IDE extension gets the tools but no hooks.

5. In each repository where memory should work:

   ```shell
   mema enable
   ```

   Turning a repository on is one of the few powerful commands, so it needs a fresh passkey approval
   (a **step-up**): `mema` prints a code and opens an approval page that shows the same code and what
   will change; approve with your passkey.

Chapter [02 §6](02-local-mode.md) shows what then happens in a session. To sign the PC in again later,
run `mema login` (`--no-browser` prints the link instead of opening it). `mema logout` revokes this
PC's grant.

### Any other MCP app

Open a window for **Other**. With **Client id and secret**, enter the app's redirect URL; with **The
app registers itself**, enter its redirect host. Untick **Can save memories** for a read-only
connection. Other apps start with the narrower sections and saves as observations, like Gemini.

## 4. When an app shows an error

Start with `mema doctor` on the PC and the alerts on the admin page's **Home**: each alert says what to
do. Then:

| You see | Why | Do |
| --- | --- | --- |
| The consent page shows only "Enter the code shown in your admin UI" | this browser was not tied to the window | type the **Pairing code** from the admin page |
| The connection fails after you click Connect, or the consent page says the request is not valid | the window closed: it expired, was used, or a second app tried to register during it (alert "Two apps tried to pair at once") | open a new window and connect again; disconnect any app under **Apps** you do not recognise |
| "This app is already connected: tick Replace to connect it again." | one connection per app | tick **Replace its current connection** |
| A chat app that worked for months asks you to connect again | its renewal ran out: 30 days unused, or 180 days in all (Grok: 90) | open a window with **Replace** and connect again |
| A coding tool's call fails with `UNAUTHORIZED` and "Run `mema login`." | this PC's grant expired (7 days unused, or 30 days in all) | `mema login` |
| `CLIENT_TOO_OLD` | the store needs a newer `mema` | `npm install -g memory-anywhere@<version>`, then `mema init` |
| `STORE_UNAVAILABLE`, or recall starts with "Offline copy from …" | the store is not answering | saves wait in the spool; `mema status` shows the store, `mema sync` sends them later |
| Codex never loads memory at the start of a session | its hooks are not trusted | `/hooks` (CLI) or Settings → Hooks |
| Gemini never calls the tools | only 3.1 Pro does | switch the model to 3.1 Pro |
| ChatGPT or Gemini use old tool descriptions after a server update | they keep the list until refreshed | ChatGPT: the connector's settings → **Refresh tools**; Gemini: connect it again with **Replace** |

Next: [04 · Your own AWS](04-your-own-aws.md)
