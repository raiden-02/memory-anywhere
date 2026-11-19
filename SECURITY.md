# Security

memory-anywhere holds a person's private memory, so a vulnerability can expose exactly what its owner
meant to keep. Please report one privately.

## Reporting

Use GitHub's **Report a vulnerability** button on this repository's Security tab (private vulnerability
reporting). Include what an attacker needs (network position, a paired app, a PC sign-in), what they
gain, and the steps to reproduce. Please do not open a public issue.

A fix ships in a signed release, and the advisory credits you unless you ask otherwise.

## Scope

In scope: the server (`packages/server`), the client and its hooks (`packages/client`, `plugins/`), the
AWS stack and host scripts (`deploy/aws`), and the release signing and update path.

Out of scope: what the AI vendors do with content their apps recall or save, and the risks the
[README](README.md#risks-you-accept) lists as accepted. The threat model is in
[auth-and-security](docs/design/spec/auth-and-security.md).
