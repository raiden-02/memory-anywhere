# 0117 The Windows client folder lives outside AppData

Status: accepted
Date: 2026-11-17
Milestone: M4

## Context
On Windows the client kept data in `%LOCALAPPDATA%\memory-anywhere` and config in `%APPDATA%\memory-anywhere`
(config-and-cli.md §3). The Claude desktop app is an MSIX package: what its processes (Claude Code's plugin, hooks and
shells) write under AppData lands in `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\…`, a copy only that app sees.
Since M3 the client has detected such copies and warned. It was not enough:

```
 Claude app processes ──► LocalCache copy of tokens.json ──┐   the PC token rotates on every refresh:
 Cursor, Codex, terminal ──► real AppData tokens.json ─────┘   one copy's refresh retires the other's
                                                              token, and the server refuses it
```

On 2026-11-17 the PC had been signed out for days (`invalid_grant`, 83 writes spooled), and every refresh inside the
Claude app made a new copy. Cursor's M2 failure fits the same family: ADR-0109 found Cursor unable to read scripts
under `%LOCALAPPDATA%`.

## Options
1. Keep AppData and warn louder: the copy comes back with every refresh inside the app; the owner cannot keep up.
2. Stop rotating the PC's refresh token: weakens the PC grant for every user to work around one platform.
3. Move the folder where packaged apps are not virtualized, `%USERPROFILE%\.memory-anywhere` (data and config in one
   folder, as on macOS). Chosen by the owner.

## Decision
`resolvePaths` uses `%USERPROFILE%\.memory-anywhere` on Windows; `MA_HOME` still overrides it. `mema init` moves a
pre-0.4.2 install there before it reads `client.toml`: the data folder by one rename, then each config file, so ACLs are
kept and nothing is copied. It refuses inside a package container, never merges into an existing folder, explains a
folder held open or on another drive, and names any package's stale copy for the owner to delete (it may hold a copy of
the dev release key, so the client does not delete it). It then removes and re-adds the Claude Code and Codex
marketplaces and points Codex's server entry at the new bundle. Until `init` runs, every other command except `mcp`
prints a warning. Spec: config-and-cli.md §3, clients.md §6, topology-and-ipc.md §9.

## Consequences
- On the owner's PC the move ran on 2026-11-17: doctor passed every check, the 83 spooled writes were sent, and in
  suite X Cursor saved and recalled for the first time.
- Codex hooks name the bundle's path, so Codex may ask to trust them again.
- A hidden folder in the profile is less conventional than AppData on Windows; the gain is one shared token.
- The `appdata.virtualized` check now matters only when `MA_HOME` points into AppData.
