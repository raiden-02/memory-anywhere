# Contributing

## Set up

You need Node 24 or newer and pnpm (the version in `package.json` `packageManager`; `corepack enable`
picks it).

```sh
pnpm install
pnpm check
```

`pnpm install` also points git at `.githooks/`. The pre-commit hook refuses a commit whose staged files
contain personal data (cloud ids, IP addresses, user paths, emails); if you set `MA_DOMAIN` (your own
store's hostname) or `MA_PRIVATE_TERMS` (comma-separated words), it refuses those too. Nothing else is
needed to contribute: no AWS account, no API keys.

## Before you open a pull request

`pnpm check` runs what CI runs on every platform: typecheck, lint, the Prettier check, the repository
guard and every test. Two habits keep it green:

- **Format from the repository root** (`pnpm format`). Prettier reads `.prettierignore` from the current
  folder, so running it inside a package reformats generated files.
- **Regenerate after changing a policy text or a tool schema** (`pnpm gen`). Generated files are
  committed, and a test fails when one is out of date.

## What a change should look like

- Behaviour follows the specs in `docs/design/spec/`. If a change needs a new rule, change the spec in the
  same pull request; if the spec is ambiguous, open an issue rather than choosing.
- Comments explain the code, never the history: no issue numbers, milestones or "we decided on" notes.
  The pull request carries the history.
- No personal data anywhere in the repository, including test fixtures and result files: use
  `memory.example.com`, `you@example.com`, `111122223333`, `203.0.113.10`.
- Indentation is tabs; line width is 120.

## Windows

Everything runs on Windows; CI tests it, with spaces in paths. Use Git Bash or PowerShell; the hooks run
under Git's own `sh`.

## Releasing

A release is a tag: bump `packages/client`, `packages/server` and `packages/importers` to the same
version, commit, and push `v<version>`. The release workflow tests and builds the server tarball, signs it
with the release key, publishes it as a GitHub release, then publishes `memory-anywhere-server` and
`memory-anywhere` to npm with provenance. Both signing and publishing wait for an approval in the
`release` environment.

The environment needs, once:

- `RELEASE_MINISIGN_KEY`: the private half of `deploy/aws/release-keys/release.pub` (deployment-aws.md
  §7.4).
- `NPM_TOKEN`, for the first publish only: an npm granular token allowed to publish new packages. After
  it, add this repository's `release.yml` as a trusted publisher on both packages' npm settings and
  delete the token; later releases publish with GitHub's identity alone.

## Where things are

[AGENTS.md](AGENTS.md) maps the packages and commands; [the architecture chapter](docs/design/architecture.md)
explains how they fit.
