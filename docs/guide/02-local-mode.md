# 02 · Local mode

At the end of this chapter the store runs on your PC, and Claude Code, Codex and Cursor on that PC share
one memory.

## 1. A notebook in your desk drawer

Local mode keeps the notebook from [01](01-how-it-works.md) in your own desk drawer. Anyone sitting at
your desk can open it; nobody outside the room can even see the drawer:

```
  ┌──────────────────────────── your PC ──────────────────────────────┐
  │                                                                   │
  │   Claude Code ──┐                                                 │
  │   Codex ────────┼──▶  127.0.0.1:47821  ▣ store                    │
  │   Cursor ───────┤                                                 │
  │   mema ─────────┘                                                 │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
        claude.ai   ChatGPT   Gemini   Grok   your phone        ✕ cannot reach it
```

What is really going on: the store is a small server program on your PC. It listens only on
`127.0.0.1`, the address that means "this computer", on port 47821, and refuses anything else. Every
request must carry the **local token**, a random secret in a file only your user account can read.

That token replaces everything chapter 01 described for strangers on the internet: there are no
[pairing windows or passkeys](01-how-it-works.md) in local mode, because nobody outside your PC can
connect. The price: every program running as you can read the token, so local mode trusts every
program running as you.

## 2. What you need

- Windows, macOS on Apple silicon, or Linux. Intel Macs are not supported: the runtime of the embedding
  model (the one that places memories by meaning, [01 §7](01-how-it-works.md)) has no build for them.
- Node 24 or newer, with npm (it comes with Node).
- Any of Claude Code, Codex or Cursor. `init` sets up the ones it finds; with none, the store still
  works from the `mema` command.

## 3. Install

1. Install the command line tool. It is called `memory-anywhere`, with the short name `mema`.

   ```shell
   npm install -g memory-anywhere
   ```

   `mema --version` now prints a version number.

2. See what `init` would change, without changing anything. It prints every file it would write, each
   as a diff, notes that it will install the server package `memory-anywhere-server` at the same
   version, and ends with `dry run: would run the server's init, …`.

   ```shell
   mema init --local --dry-run
   ```

3. Run it for real:

   ```shell
   mema init --local
   ```

   It first asks for your **deny-list**: Git hosts, or host/path prefixes, where memory must never be
   used, such as your employer's Git server. Repositories cloned from there can never be turned on. Then
   it shows the same diffs and asks `Make these changes? [y/N]`. Answer `y`. You see, in order:
   - `installing memory-anywhere-server@<version>…`: npm installs the server, with its embedding
     runtime, into its own folder, and runs no install scripts;
   - the server's own setup: it creates the store and downloads and verifies the embedding model (a few
     minutes the first time);
   - `server running at http://127.0.0.1:47821`;
   - the coding tools' plugins being installed, then `next:` lines for what only you can do;
   - a custom instruction for chat apps (not used in local mode; chapter 03 uses it);
   - a `mema doctor` report (§5).

5. Do what the `next:` lines say (the last one, `mema enable`, is §6):
   - **Codex:** trust the two memory-anywhere hooks once, in `/hooks` (CLI) or Settings → Hooks
     (desktop app). Codex skips untrusted hooks without a word, so memory would never load.
   - **Cursor:** run **Developer: Reload Window** so the plugin and its hooks load.
   - **Claude Code:** nothing, unless it asks you to approve the plugin's hooks.

## 4. What it set up, and where

Everything lives in one folder per computer. On Windows it sits in your profile, not under AppData:
desktop apps installed from the Microsoft Store keep a private copy of whatever is written under
AppData, and two copies of a token would sign each other out.

| | Data and settings |
| --- | --- |
| Windows | `%USERPROFILE%\.memory-anywhere\` |
| macOS | `~/Library/Application Support/memory-anywhere/` |
| Linux | data in `~/.local/share/memory-anywhere/`, settings (`client.toml`, `server.toml`) in `~/.config/memory-anywhere/` |

Inside it:

| Item | What it is |
| --- | --- |
| `client.toml` | which store the PC uses (`mode = "local"`) and your deny-list |
| `server.toml` | the local server's settings |
| `local.token` | the owner credential; readable only by you |
| `server/` | the store itself (`store.db`) and the server's log (`server.log`) |
| `server/app/<version>/` | the installed server package, one folder per version |
| `models/` | the embedding model |
| `cache/`, `spool/`, `logs/` | session-start context, saves waiting for the server, client logs (never prompt text) |
| `plugins/`, `bin/` | the installed plugin copies and the bundle the hooks call |

The server starts each time you sign in to your computer, with no window and no admin rights:

| | Start at sign-in |
| --- | --- |
| Windows | value `memory-anywhere server` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |
| macOS | `~/Library/LaunchAgents/dev.memory-anywhere.server.plist` |
| Linux | `~/.config/systemd/user/memory-anywhere.service` |

In the coding tools' own folders `init` installs the Claude Code and Codex plugins, the Cursor plugin
in `~/.cursor/plugins/local/memory-anywhere/` with its hooks in `~/.cursor/hooks.json`, a server entry
in `~/.codex/config.toml` for the Codex IDE extension, and one shared skill in
`~/.agents/skills/memory-anywhere/`. Each file it changes keeps its previous content next to it as
`<file>.ma-bak-<timestamp>`.

To update later, update the command line tool, then run `init` again. It installs the server of the new
version beside the old one, stops the old server, upgrades the store (a copy of it is kept first), starts
the new server and removes the old version's folder:

```shell
npm install -g memory-anywhere@latest
mema init --local
```

## 5. Check it: `mema doctor`

```shell
mema doctor
```

Each line is one check: `pass`, `warn` or `fail`, its id, what it found, and for anything not passing a
`fix:` line. For example:

```
pass  store.reachable                   http://127.0.0.1:47821 answers
pass  local.token                       present
pass  coding-tools                      found claude-code, codex
pass  claude-code.plugin                installed
warn  codex.hooks-trusted               0 of 2 hooks trusted
                                        fix: trust them in Codex: /hooks (CLI) or Settings → Hooks
```

It exits with code 6 when any check fails. The one you are most likely to meet:
`store.reachable` fails when the server is not running; it starts when you sign in to your computer, so
sign out and back in, then run `mema doctor` again.

## 6. Use it from your coding tools

A coding tool works in many folders, and some of them are not yours to remember (a client's code, an
employer's). So memory is **off in every repository** until you turn it on there, like a notebook that
opens only in rooms you unlocked:

```shell
cd path/to/your/repository
mema enable
```

It asks `Track this repo as a project? [Y/n]` and the project's name, then prints `enabled <name>`. A
tracked project is kept as a project in your memory, so the tools know what it is.

What then happens in a session:

```
 session starts                 you type a prompt              the model decides to save
 ───●───────────────────────────────●──────────────────────────────●──────────────▶ time
    hook loads your profile         prompt hook: only in enabled    memory_save → the desk
    and this repository's notes     repos, and only learned from    (01 §3)
                                    with --capture
```

- **At start**, a hook (a command the tool runs on an event) gives the model your profile and this
  repository's context, so it knows you before your first word.
- **While you work**, the model calls `memory_save` and `memory_recall` itself.
- **Your prompts** are learned from only if you turned that on with `mema enable --capture`. Without
  it, prompts from enabled repositories are kept for 24 hours only to check that a save quotes your
  own words.

Useful everyday commands:

| Command | Does |
| --- | --- |
| `mema disable` | turns memory off in the current repository |
| `mema search <query>` | looks something up in your memory from the terminal |
| `mema status` | the store, its health, and how many saves wait in the spool |
| `mema sync` | sends waiting saves and refreshes the caches |
| `mema review` | lists the [review items](01-how-it-works.md) waiting for you |
| `mema ui` | opens the admin page in your browser, signed in with a one-time link |

If the server is down, coding tools keep working: saves wait in the spool and `mema sync` (or the next
session) sends them; recall answers from the last cached copy, marked as offline.

## 7. What local mode cannot do

- **Phone and web apps.** claude.ai, ChatGPT, Gemini and Grok call tools from their own servers on the
  internet, which cannot reach `127.0.0.1` on your PC. For them, run the store in your own AWS account
  (chapter [04](04-your-own-aws.md)).
- **Work while the PC is off.** The store is wherever the PC is.
- **Keep off-machine backups.** The store is one file on this disk. Keep encrypted copies with
  `mema export --out <file>`, after registering an export key on the admin page's **Exports** tab.
- **History imports.** Reading old chats needs a language model ([05](05-import-history.md)); the local
  server starts without one.

To move to your own AWS later, point the PC at the new store:

```shell
mema connect https://memory.example.com
```

This leaves local mode: the local server stops and no longer starts at sign-in, and its store stays in
the `server/` folder as a backup.

## 8. Uninstall

1. Export first if you want to keep anything: the last step deletes the store.

2. Remove the plugins in each coding tool: the plugin `memory-anywhere` in Claude Code and in Codex,
   using the tool's plugin manager; for Cursor, delete `~/.cursor/plugins/local/memory-anywhere/` and the
   two entries that mention `memory-anywhere.mjs` in `~/.cursor/hooks.json`. The `.ma-bak-<timestamp>`
   files next to each tool's settings hold their content from before `init`.

3. Stop the start at sign-in.

   Windows (then sign out and back in, which stops the running server):

   ```powershell
   reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "memory-anywhere server" /f
   ```

   macOS (stops it at once):

   ```bash
   launchctl unload -w ~/Library/LaunchAgents/dev.memory-anywhere.server.plist
   rm ~/Library/LaunchAgents/dev.memory-anywhere.server.plist
   ```

   Linux (stops it at once):

   ```bash
   systemctl --user disable --now memory-anywhere.service
   rm ~/.config/systemd/user/memory-anywhere.service
   ```

4. Delete the folder, and with it the store.

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.memory-anywhere"
   ```

   ```bash
   # macOS
   rm -rf ~/Library/Application\ Support/memory-anywhere
   # Linux
   rm -rf ~/.local/share/memory-anywhere ~/.config/memory-anywhere
   ```

5. Remove the command.

   ```shell
   npm uninstall -g memory-anywhere
   ```

Next: [03 · Connect apps](03-connect-apps.md)
