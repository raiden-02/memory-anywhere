# memory-anywhere

One personal memory that all your AI apps share. Tell Claude something about yourself, and ChatGPT,
Gemini, Grok, Cursor, Claude Code and Codex know it too, on the PC and on the phone.

```
   Claude ──┐            ┌── Cursor
  ChatGPT ──┤            ├── Claude Code
   Gemini ──┼──▶  ▣  ◀──┼── Codex
     Grok ──┘   store    └── mema (you)
```

The store keeps what stays true (preferences, stable facts, people, projects, decisions, corrections)
and refuses the rest: task details, secrets, and sensitive topics unless you ask. Every save goes through
the same fixed rules, so an app cannot overwrite what you said or raise its own trust. The store belongs
to you alone and runs on your PC or in your own AWS account, never on a shared service.

## Start on your PC

You need Node 24 or newer.

```sh
npm install -g memory-anywhere
mema init --local
```

`init` finds Claude Code, Codex and Cursor, shows every file it will change, installs the matching
server package, and asks once. Open your
coding tool in a repository, run `mema enable` there, and say something about yourself; a new session
will know it. Local mode keeps everything on this PC, so phone and web apps cannot reach it.
[Guide: local mode](docs/guide/02-local-mode.md).

## Reach it from every app

Phone and web apps need a store on the internet. `mema deploy aws --stage prod` builds one small
machine in your own AWS account, at a hostname you own (for example `memory.example.com`), with
continuous backups. Then you connect each app through a short pairing window that you open and approve
with a passkey. [Guide: your own AWS](docs/guide/04-your-own-aws.md) ·
[Guide: connect apps](docs/guide/03-connect-apps.md).

It costs about **$21 a month** in us-east-1, the machine being $12 of that
([measured](docs/results/report.md)). Local mode costs nothing. Budget alerts email you when the month's
forecast passes $25 or the bill passes $30.

## What it promises

- **Deleting means deleted.** A purged memory is unreadable at once, gone from the machine's files within
  48 hours and from every backup within 30 days.
- **History cannot be quietly rewritten.** A daily manifest of the store's hash goes to a bucket that no
  one, AWS root included, can change for 90 days.
- **No app connects unless you let it.** Each new connection needs a pairing window you opened and a
  passkey approval; every new connection emails you.

## Risks you accept

memory-anywhere limits who can read and write your memory. It cannot limit these:

- **The AI vendors** (Anthropic, OpenAI, Google, xAI) see what their app recalls or saves, under their
  own retention and training settings. Gemini keeps activity 18 months by default and has some chats
  reviewed by people: set its auto-delete to 3 months, and keep sensitive sections off for remote apps.
- **Gemini** may pass content from your email and connected apps, including other people's messages,
  into what it saves.
- **The extraction model** you configure sees your redacted prompts from the repositories you enable,
  and the history you import.
- **Malware running as you on your PC** can use the PC's sign-in, within its limits, until you revoke it.
- **During a deploy** (at most one hour, signed in to the deploy role), a hijacked agent on the PC could
  change the machine and so reach the data. Every such change sends an immediate alert.
- **AWS** operates the encryption keys: encryption protects against a leaked bucket, not against AWS.
- **Your hostname is public** (certificate logs), and your DNS provider could repoint it if your account
  there were taken over. No control depends on the hostname being secret; TLS and the pairing window
  contain a repointed record.

The full threat model: [auth-and-security](docs/design/spec/auth-and-security.md).

## Learn more

The docs are a short course: [docs/README.md](docs/README.md). It starts with
[how it works](docs/guide/01-how-it-works.md) and ends with the measured results.
Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security reports: [SECURITY.md](SECURITY.md) ·
License: [MIT](LICENSE).
