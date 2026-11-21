# Working in this repository

memory-anywhere is a personal memory server that AI apps share over MCP, plus the client that connects
them. Read [docs/design/architecture.md](docs/design/architecture.md) first: it shows what runs where and
how a save and a recall flow.

## Map

| Path | What it is | Start at |
| --- | --- | --- |
| `packages/contracts` | Schemas, normalization, reason codes, shared by client and server | `src/` |
| `packages/server` | The store: MCP tools, `/v1`, OAuth, admin pages, write path, recall, jobs | [README](packages/server/README.md) |
| `packages/client` | The `mema` CLI, stdio proxy, hooks, spool, `init`, `doctor`, `deploy` | `src/cli.ts` (the command table) |
| `packages/importers` | One module per import source | `src/` |
| `plugins/` | Claude Code, Codex and Cursor plugins | each `README` or manifest |
| `deploy/aws` | The CDK stack, host scripts, IAM | [README](deploy/aws/README.md) |
| `evals/` | The benchmark suites | [README](evals/README.md) |
| `docs/` | A course: guides, architecture, specs, results | [docs/README.md](docs/README.md) |

## Commands

```sh
pnpm check                # typecheck, lint, format check, repository guard, every test
pnpm test packages/server # one package's tests
pnpm format               # from the repository root only
pnpm gen                  # after editing packages/server/policy/ or a tool schema
pnpm eval run --suite W   # a benchmark suite; none needs an API key
```

## Rules

- **The specs own behaviour.** `docs/design/spec/<topic>.md` is normative; code comments cite it as
  `write-path.md §8.2`. The owning spec for each topic is listed in the architecture chapter, §8. If a
  spec is ambiguous or contradicts itself, stop and ask; do not invent behaviour.
- **No personal data in the repository**: no names, usernames, machine names, emails, domains, cloud
  account or resource ids, IP addresses, local paths. Use `memory.example.com`, `you@example.com`,
  `111122223333`, `203.0.113.10`. The pre-commit hook (`scripts/check-repo.ts`) enforces the shapes it
  can recognize; the rest is on you.
- **Comments explain the code, not the history**: no issue numbers, milestones or dated decisions.
- **Every path works on Windows**, including paths with spaces.
- **Do not change a CloudFormation logical id** in `deploy/aws` unless replacing that resource is the
  point; `deploy/aws/test/stack.test.ts` pins them.
- **Tests come with the change**: a new decision row, store rule or tool field gets a unit test; the write
  path also has property tests.
- Tabs, line width 120, Prettier; `pnpm check` must pass before a commit.
