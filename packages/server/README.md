# @memory-anywhere/server

The store behind memory-anywhere: one process, one SQLite file. Apps talk to it over MCP; hooks, the spool and
`mema` use a small internal API (`/v1`); the owner uses the admin pages.

## The picture

Think of a librarian with one notebook. Apps hand in notes (`memory_save`) or ask questions (`memory_recall`).
Every note passes the same desk, which decides whether it is kept, held until it comes up again, put in front of
the owner, or refused. Every question is answered only from notes that app may see.

## A request, from the socket to the notebook

```
app ─HTTPS─▶ http/server.ts ──▶ auth/resource.ts ──▶ api/mcp.ts ──▶ api/tools.ts
             surface, limits     token → Grant        MCP protocol    the five tools
                                                                         │
                                        save / forget ┌──────────────────┴──────────────┐ recall / profile
                                                      ▼                                 ▼
                                            write/pipeline.ts                    recall/recall.ts
                                       verify → resolve → screens          time → FTS + vectors → filters
                                       → decide → store rules              → budget → render
                                                      │                                 ▲
                                                      └──────▶ store/ (SQLite) ─────────┘
```

- **`http/server.ts`** runs every request through the same gates in order (surface, origin, credential, rate
  limit, client version, body size) before any store work; its header comment lists them.
- **`auth/resource.ts`** turns a bearer token into a `Grant`: which app, its class, its scopes. In local mode
  `api/grant.ts` does the same from the local token.
- **`api/tools.ts`** checks the input against the tool's schema and the grant's scopes, then calls the write or
  read path. A tool returns either a result or a yes/no question for the person (`ToolOutcome`).
- **`write/pipeline.ts`** is the one entry point for every save, from any channel (tools, spool replays, capture,
  imports). Each step is its own file: `verify.ts`, `resolve.ts`, `screens.ts`, `decide.ts` (a pure decision
  table), `store-rules.ts`.
- **`recall/recall.ts`** is the read path: deterministic steps from a query to rendered notes; `reader.ts` decides
  what the caller may see and `render.ts` escapes everything an app is shown.

`app.ts` builds the `App` that the HTTP layer, the job worker and the CLI all share, so there is exactly one write
path and one read path.

## Folders

| Folder       | What lives there                                                                      |
| ------------ | ------------------------------------------------------------------------------------- |
| `http/`      | The HTTP server, its gates, the `/v1` internal API, request logs, rate limits         |
| `auth/`      | OAuth for public stores: pairing, passkeys, consent, grants, step-up approvals        |
| `api/`       | MCP: the endpoint, the five tools, elicitation between rounds                         |
| `write/`     | The write path: save, forget, observations, review items, imports                     |
| `recall/`    | The read path: recall, profile, session-start context, the vector index               |
| `store/`     | Opening the database, migrations, the event log, dumps and hashes, the clock          |
| `policy/`    | Lexicons and size budgets; `generated.ts` is built from `policy/` by `pnpm gen`       |
| `llm/`       | The one adapter every model call goes through, and its prompts                        |
| `embed/`     | The pinned embedding model, run on the CPU                                            |
| `jobs/`      | Background jobs: expiry, pruning, key rotation, dynamic sections                      |
| `ops/`       | Alerts, exports and imports of whole stores, the daily manifest, the outbox, restores |
| `admin/`     | The owner's pages and CLI commands                                                    |
| `web/`       | Templates, assets and labels for every server-rendered page                           |
| `config/`    | The `server.toml` schema with every default                                           |
| `migrations` | Forward-only SQL migrations, applied in number order                                  |

## Working on it

```sh
pnpm test packages/server    # unit, property and conformance tests
pnpm gen                     # after editing policy/ or a tool schema
node src/cli.ts start --config <file>
```

Tests build their stores with the helpers in `test/helpers/`. The specs in `docs/design/spec/` own the behaviour; each
file's header names the section it implements.
