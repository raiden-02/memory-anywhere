# Negative results

Every failed attempt, wrong assumption and overturned result, with where it is recorded. Newest milestone first.

## M0

| Date | Question | What failed or was overturned | Outcome | Record |
| --- | --- | --- | --- | --- |
| 2026-11-07 | Q20 | One 50-handshake run picked us-east-2 (93.0 vs 94.3 ms); a repeat picked us-east-1. The spec's "lowest median; ties → us-east-1" did not define a tie | The tie is defined statistically (CI of the median difference includes 0); us-east-1 chosen | [ADR-0112](../decisions/ADR-0112-region-and-litestream.md) |
| 2026-11-08 | Q25 | `aws sso login --no-browser` (authorization code with a `127.0.0.1` callback) never completed when the owner signed in from an Incognito window; the CLI kept waiting | `aws sso login --sso-session ma-deploy --use-device-code` worked and is the documented sign-in from now on | [ADR-0113](../decisions/ADR-0113-identity-center-separation-and-operator-path.md) |
| 2026-11-08 | Spike deploy | The first `cdk deploy` failed at changeset creation: CloudFormation resolves the CDK template's `BootstrapVersion` parameter (SSM type, `/cdk-bootstrap/hnb659fds/version`) with the stack's execution role, and `memory-anywhere-cfn-exec-services` allows SSM only under the stage prefixes | The stack is synthesized without the bootstrap-version rule (`generateBootstrapVersionRule: false`); the CDK CLI still checks the version through the deploy role. No IAM change, no re-bootstrap. A test now fails if the template has any SSM-resolved parameter | [ADR-0113](../decisions/ADR-0113-identity-center-separation-and-operator-path.md) |
