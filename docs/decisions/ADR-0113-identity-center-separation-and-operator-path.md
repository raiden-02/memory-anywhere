# 0113 Identity Center separation (Q25), operator path (Q26), budgets in the member account (Q27)

Status: accepted (Q25, Q26, Q27: design as written; the M0-only operator exception was removed before the final Q25 run)
Date: 2026-11-08
Milestone: M0
Question: Q25, Q26, Q27

## Bootstrap (deployment-aws.md §3.3, m0-spike.md §6 item 7)

The owner ran both scripts in CloudShell from the reviewed commit `7deba3b033e5ebfbca9623726b77e310726e0bac`:

1. `bootstrap-member.sh <member> us-east-1` as `ma-operator` with the temporary `AdministratorAccess`. It created `memory-anywhere-boundary`, `memory-anywhere-cfn-exec` and `memory-anywhere-cfn-exec-services`, bootstrapped CDK (aws-cdk 2.1148.0) with the two execution policies, set the account IMDS default (tokens required, hop limit 1) and enabled account-level S3 Block Public Access. Its verification block shows all four.
2. `bootstrap-identity.sh <member> us-east-1` in the management account. It created the `memory-anywhere-deploy` and `memory-anywhere-operator` permission sets, removed the temporary `AdministratorAccess` assignment and ended with `OK: exactly the two expected assignments.`

A first attempt of step 1 in the management account was refused by the script's account check before it changed anything (kept in the evidence as a negative test).

Evidence: [`bootstrap-member.txt`](../results/evidence/ADR-0113/bootstrap-member.txt), [`bootstrap-identity.txt`](../results/evidence/ADR-0113/bootstrap-identity.txt).

## Q25 Identity Center separation

### Context
The PC runs the agent and holds only the `ma-deploy` sign-in (ADR-0020). Q25 asks whether that sign-in can reach operator rights or any account other than `memory-anywhere`. M0 cannot pass unless it cannot (m0-spike.md §6).

### Options
1. Design as written: two permission sets, explicit denies on sessions, commands, prod secrets, prod backups, KMS use and identity/organization services.
2. If anything leaks: fix the permission sets or the assignments and re-run.

### Method
- `spikes/separation/src/q25.ts`, AWS CLI v2 on the owner's PC (Windows 11 Home 10.0.26200, Node 24.22.2), profile `memory-anywhere-deploy`, region us-east-1, after `aws sso login --sso-session ma-deploy --use-device-code` (owner, Incognito window).
- It lists the reachable accounts and roles with the SSO token, tries each operator action, tries other ways out of the deploy role (OrganizationAccountAccessRole, IAM, Organizations, Identity Center admin, KMS), then repeats the secret and backup reads through the CDK lookup role (ReadOnlyAccess minus `kms:Decrypt`), which the deploy role is allowed to assume.
- It always ends with `aws sso logout` and scans `~/.aws/sso/cache` and `~/.aws/cli/cache` for any access token, refresh token or role credentials.
- A check passes only on the expected outcome. A read of a resource that does not exist yet (`ParameterNotFound`, S3 404) is **pending**, never a pass: S3 reports a missing bucket before evaluating IAM, and SSM reports a missing parameter to any principal with `GetParameter`.

### Result
Run `pre-stack`, 2026-11-08, before any stack existed: **15 pass, 0 fail, 7 pending.** Evidence: [`q25-pre-stack.json`](../results/evidence/ADR-0113/q25-pre-stack.json).

| Check | Outcome |
| --- | --- |
| Caller | `AWSReservedSSO_memory-anywhere-deploy_…/ma-deploy` in the member account |
| `sso list-accounts` | exactly one: `memory-anywhere` |
| `sso list-account-roles` | exactly one: `memory-anywhere-deploy` |
| `ssm start-session`, `ssm send-command` | AccessDenied (explicit deny) |
| prod `setup-token`, prod `llm/api_key` | AccessDenied (explicit deny) |
| assume `OrganizationAccountAccessRole`; `iam list-users`; `organizations describe-organization`; `sso-admin list-instances`; `kms list-keys` | AccessDenied |
| assume the CDK lookup role | allowed (CDK needs it) |
| lookup role: `ssm start-session` | AccessDenied |
| spike setup token (deploy and lookup role), prod setup token (lookup role), prod and spike backup buckets (both) | pending: resource does not exist yet |
| `aws sso logout`, then cache scan | no token or credentials left |

Observation for the re-run: the lookup role received `ParameterNotFound`, not AccessDenied, for `/memory-anywhere/setup-token`, so it may call `ssm:GetParameter` on every path. Its only barrier to a secret's value is the denied `kms:Decrypt`, which holds only while every secret parameter is a SecureString.

**Removal of the M0 exception, 2026-11-10.** The owner removed `memory-anywhere-operator` from `ma-deploy` in management-account CloudShell, then re-ran the reviewed `bootstrap-identity.sh` (commit `7deba3b`): "OK: exactly the two expected assignments." (`memory-anywhere-deploy` → `ma-deploy`, `memory-anywhere-operator` → `ma-operator`). The PC's temporary `memory-anywhere-operator` profile was deleted from `~/.aws/config` and its cached role credentials removed. Evidence: [`operator-exception-removed.txt`](../results/evidence/ADR-0113/operator-exception-removed.txt).

Run `final`, 2026-11-10, after the removal, with the spike stack up (backup bucket, CMK and a real SecureString setup token): **19 pass, 0 fail, 0 pending, 3 deferred.** Evidence: [`q25-final.json`](../results/evidence/ADR-0113/q25-final.json).
- `sso list-account-roles` lists exactly `memory-anywhere-deploy` again; the operator role is gone.
- Spike setup token: the deploy role and the CDK lookup role both fail at `kms:Decrypt` on the stack's CMK, each "with an explicit deny in an identity-based policy". So the SecureString's encryption is the barrier, as observed above.
- Spike backup bucket: 403 for both.
- The 3 deferred checks read prod resources (`/memory-anywhere/setup-token` through the lookup role; the prod backup bucket through both) that do not exist until M2. M2's first prod deploy re-runs Q25 with them.
- `aws sso logout` left no token or role credentials.

### Decision
**Accepted: design as written.** The final run has 0 fail and 0 pending against real resources. The only open checks need prod resources, which M2 creates; the M2 deploy checklist re-runs `q25.ts` once they exist. Every secret parameter must stay a SecureString under the stack's CMK, because the lookup role can call `ssm:GetParameter`.

## Q26 Operator path

### Method
- Run 1, 2026-11-08, by the owner in member-account CloudShell as `ma-operator`, `ma-operator.sh` from the reviewed commit `fd0ef2c`: `setup-link --stage spike`. Evidence: [`q26-cloudshell-run1.txt`](../results/evidence/ADR-0113/q26-cloudshell-run1.txt).
- Run 2, same day, under the owner's M0-only exception (spec-issues.md #13: the operator permission set is temporarily also assigned to `ma-deploy` and used from the PC through the `memory-anywhere-operator` profile): `spikes/separation/q26.sh` runs `setup-link` twice, `set-llm-key` with a dummy value, and one direct `AWS-RunShellScript` Run Command. Evidence: [`q26-run2.txt`](../results/evidence/ADR-0113/q26-run2.txt).

### Result
- Run 1: CloudShell opened as `ma-operator`; the script ran; SSM Run Command reached the instance and executed. The stub then failed (it opened its store under the working directory, `/usr/bin` under Run Command); fixed in release `0.0.1-m0.2`.
- Run 2: every step succeeds. `setup-link` renewed the token on the instance through Run Command, the outbox helper stored it as a SecureString within a second, and a second call reused the unexpired token. `set-llm-key` stored the key and restarted the secrets and server units (`active`, `secrets.env` present). The direct Run Command published an SNS message and reported `caddy`, `memory-anywhere`, `memory-anywhere-outbox.path` and `memory-anywhere-secrets` active.
- Running the script on Windows needed three portability fixes in `ma-operator.sh` (MSYS path conversion of `/…` parameter names, native temp paths, UTF-8 CLI output); none changes its behaviour in CloudShell.

### Decision
**Accepted: design as written.** The operator path works from CloudShell (run 1) with the same script. The PC use in run 2 is the owner's temporary M0 exception, removed before M0 closes (Q25 final run).

## Q27 Budgets and Cost Anomaly Detection in the member account

### Result
Evidence: [`q27.txt`](../results/evidence/ADR-0113/q27.txt). In the member account, with no management-account Cost Explorer change, CloudFormation created and AWS now runs: the budget `memory-anywhere-spike` (monthly, $30 limit, alerts at $25 forecast and $30 actual, both to SNS; it reports actual spend) and the Cost Anomaly Detection monitor with its subscription (`IMMEDIATE` to SNS, $5 absolute impact; spec-issues.md #7). The first test alert was published but not delivered, because the email subscription was still unconfirmed (SNS does not deliver to a pending subscription). After the owner's confirmation, the second was delivered to the owner's inbox.

### Decision
**Accepted: design as written**, with the anomaly subscription at `IMMEDIATE` frequency (SNS requires it). Operational note: confirming the SNS email is an owner step right after the first deploy, and no alert reaches the owner until it is done; `mema deploy` reminds the owner, and the M2 deploy checklist must include it.

## Consequences
- Re-running the bootstrap later (for example after a cfn-exec or boundary fix) needs a temporary `AdministratorAccess` assignment again; permission-set fixes only need `bootstrap-identity.sh`.
- The owner's first `aws sso login --no-browser` (authorization-code flow with a `127.0.0.1` callback) did not complete from an Incognito window; `--use-device-code` did. The deploy instructions use the device-code flow from now on (negative-results.md).
