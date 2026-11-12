# Deployment on AWS

Status: normative for the owner's store (M2 on) and for any self-hoster using `mema deploy aws`. The M0 spike stack follows §9. Owner account steps are collected in DESIGN.md §9 (pre-M0 checklist).

## 1. Shape

One small ARM instance in a public subnet, no NAT, no load balancer, no Lambda. SQLite on encrypted EBS, Litestream to S3. Reasons (from v2, still valid): API Gateway HTTP APIs cap integrations at 30 s and cannot stream ([quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)); a VPC Lambda needs a NAT gateway (≈ $33/month) or interface endpoints; Aurora Serverless v2 resumes in about 15 s, beyond Claude's 10 s OAuth deadline ([auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)); SQLite needs one long-lived writer.

```
                    Internet (vendor clouds, owner's browser, PC client)
                                     │ 443/tcp only
                       ┌─────────────▼──────────────┐
  DNS (owner: Cloudflare, DNS-only records; others: Cloudflare or Route 53): A {host}, A admin.{host} → Elastic IP; CAA
                       │  EC2 t4g.small, AL2023 arm64, public subnet
                       │  Caddy :443 ──unix socket──► memory-anywhere-server
                       │                                  │ SQLite /var/lib/memory-anywhere/store.db (EBS gp3, KMS)
                       │  litestream (own user) ──────────┘
                       │  ma-aws helpers: secrets (boot) ◄── SSM; outbox ──► SSM / SNS / S3
                       │  ma-updater (timer) ◄── releases bucket + SSM desired-release
                       │  ma-maint (nightly, after purges)
                       └──────┬─────────────────────┘
                              │ S3 gateway endpoint (free)
             ┌────────────────▼───────────┐   ┌──────────────────────────┐
             │ backup bucket (SSE-KMS CMK, │   │ manifest bucket (from M4)│
             │ versioned, BPA, VPCE-only)  │   │ Object Lock, hashes only │
             └─────────────────────────────┘   └──────────────────────────┘

  Owner's PC: deploy SSO profile only (CloudFormation via CDK).   AWS CloudShell: operator user only.
```

## 2. Resources (CDK, `deploy/aws/`)

CDK v2 in TypeScript (`aws-cdk-lib` pinned exact). Stack name `MemoryAnywhere-<stage>` with `stage` = `prod` (owner store), `eval-<id>` (§8) or `spike` (§9). No Lambda-backed custom resources are used (no `autoDeleteObjects`); non-prod buckets are emptied by `mema destroy aws` (§6).

| Resource | Setting |
| --- | --- |
| VPC | New VPC `10.42.0.0/24`, one public subnet in one AZ, internet gateway, no NAT, S3 **gateway** endpoint on the subnet's route table |
| Instance | `t4g.small` (2 vCPU, 2 GiB), AL2023 arm64 AMI from `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` resolved at deploy and pinned in `cdk.context.json`; `CreditSpecification: standard` (ADR-0011); no key pair; detailed monitoring off |
| IMDS | `HttpTokens: required`, `HttpPutResponseHopLimit: 1`, `InstanceMetadataTags: disabled`; the account default is set in the one-time bootstrap (§3.3) |
| Root volume | gp3 20 GiB, encrypted with the CMK |
| Swap | 1 GiB swap file created by user data |
| Elastic IP | Associated with the instance; retained on stop; released only by `mema destroy aws` after DNS deletion |
| Security group | Inbound: tcp 443 from `0.0.0.0/0` and `::/0`. Outbound: tcp 443 to `0.0.0.0/0`; udp 123 to `0.0.0.0/0` (the Amazon Time Sync link-local address needs no rule) |
| Instance role | Custom policy (§3.5); no AWS managed policies |
| CMK | `alias/memory-anywhere-<stage>`, symmetric, rotation on, 30-day deletion window, key policy §3.6 |
| Backup bucket | `memory-anywhere-backup-<account>-<region>-<stage>`; §5 |
| Manifest bucket | From M4 only: `memory-anywhere-manifest-<account>-<region>-<stage>`, Object Lock compliance mode, default retention 90 days, versioning on, SSE-S3 |
| Releases bucket | `memory-anywhere-releases-<account>-<region>-<stage>`, versioned, SSE-S3, BPA |
| SSM parameters | Prefix `/memory-anywhere/` for `prod`, `/memory-anywhere-<stage>/` otherwise: `llm/api_key` (SecureString, owner sets in CloudShell), `setup-token` (SecureString, written through the outbox on first boot, deleted after setup), `release/desired` (String JSON), `acme/account-uri` (String, written through the outbox). CloudFormation cannot create SecureString parameters, so the stack creates none; the cookie and MRTR secrets live in `meta` in the database |
| DLM | Service role `memory-anywhere-dlm-<stage>` (permissions boundary attached, managed policy `AWSDataLifecycleManagerServiceRole`); daily EBS snapshot of the root volume at 05:00 UTC, keep 7 |
| SNS | Topic `memory-anywhere-alerts-<stage>`, email subscription to the owner (the owner confirms the email: an account step). Topic policy allows `sns:Publish` from the instance role, `budgets.amazonaws.com`, `costalerts.amazonaws.com` and EventBridge |
| CloudWatch | Log group `/memory-anywhere/<stage>/server`, retention 30 days; the CloudWatch agent ships journald for the five units in §4 (server, secrets, Litestream, updater, outbox) plus `ma-maint`; metric filters `ma_5xx`, `ma_auth_fail`, `ma_backup_lag`; alarms on those and on EC2 `StatusCheckFailed` → SNS |
| Budgets | Monthly cost budget: alert when the **forecast** exceeds $25 and when **actual** exceeds $30 (above the expected ≈ $21, §10; revisited after M4 measures the bill) → SNS |
| Cost anomaly | AWS Cost Anomaly Detection: one monitor over AWS services, created by the `prod` stack only, because an account allows one such monitor and it already covers every stack (spec-issues #7, #56); subscription with daily frequency and an absolute impact threshold of $5 → SNS. This catches a sudden change (for example unlimited CPU, data transfer or an LLM key misuse on AWS) long before the monthly budget does |
| CloudTrail | One trail, management events, plus data events for `PutObject` on the releases bucket, to a log bucket with 90-day expiry |
| EventBridge | Rules on CloudTrail events → SNS, immediate: KMS `ScheduleKeyDeletion`, `DisableKey`, `PutKeyPolicy`; S3 `PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketVersioning`, `PutBucketLifecycleConfiguration`; IAM policy and role changes; `ConsoleLogin` not via Identity Center; **the deploy path**: CloudFormation `CreateStack`, `UpdateStack`, `ExecuteChangeSet`, `DeleteStack` on `MemoryAnywhere-prod`; EC2 `ModifyInstanceAttribute`, `RunInstances`, `TerminateInstances`; SSM `PutParameter` on `/memory-anywhere/release/desired` and `/memory-anywhere/llm/*`, `SendCommand`, `StartSession`; S3 `PutObject` on the prod releases bucket. Every deploy is therefore visible to the owner by email |
| DNS | Not managed by the stack by default (`--dns manual`): the owner creates the records at their DNS provider (§6). With `--dns route53` (other self-hosters), the stack creates the A and CAA records in an existing Route 53 hosted zone |

## 3. Identity and access

### 3.1 Accounts and users

memory-anywhere runs in a **dedicated member account** of an AWS Organization (ADR-0025). The owner's existing account, which already hosts other workloads (a portfolio website), becomes the organization's management account and holds IAM Identity Center. The deploy and operator users are assigned permission sets **only in the member account**, so they cannot touch anything else, and the bill and blast radius stay separate.

| Account | Role in the design | Holds |
| --- | --- | --- |
| Management account (the owner's existing account) | AWS Organizations and the **organization instance** of IAM Identity Center. Account instances of Identity Center do not support permission sets or account access ([account instances](https://docs.aws.amazon.com/singlesignon/latest/userguide/account-instances-identity-center.html)), so an organization instance is required | The owner's other workloads, unchanged; Identity Center users and permission sets |
| Member account `memory-anywhere` | Every memory-anywhere resource of every stage (`prod`, `spike`, `eval-*`) | The stacks, buckets, keys, parameters |

Why two Identity Center users: AWS CLI v2 caches the Identity Center token under `~/.aws/sso/cache`, keyed by the `sso-session` name, and refreshes role credentials automatically for as long as the access-portal session lasts ([AWS SSO credentials](https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.md)). The token can fetch credentials for **every** permission set assigned to that user, and the permission set's session duration bounds only each set of role credentials. So two permission sets on one user, or two profiles on one OS account, do not separate deploy from operator rights. The separation is by **user and by place**:

| Identity Center user | Email (each user needs its own; plus-addressing works) | Assigned in the member account | Where it signs in | Holds |
| --- | --- | --- | --- | --- |
| `ma-deploy` | `you+ma-deploy@example.com` | `memory-anywhere-deploy` only | The owner's PC, through the AWS CLI profile below | CloudFormation and CDK deploys |
| `ma-operator` | `you+ma-operator@example.com` | `memory-anywhere-operator` (and, only during the one-time bootstrap, `AdministratorAccess`) | Only the AWS access portal in a private browser window, then **AWS CloudShell**. Never configured on the PC | Setup link, LLM key, restore, owner reset, store import |

Each user needs a unique email address ([add users](https://docs.aws.amazon.com/singlesignon/latest/userguide/addusers.md)); a Gmail-style plus address (`you+ma-deploy@…`, `you+ma-operator@…`) delivers to the owner's normal inbox. The member account needs its own email too (`you+ma-aws@…`). Real addresses never go into the repository. Each user has its own MFA device (for example the PC's platform authenticator for `ma-deploy`, a hardware key or the phone for `ma-operator`). Identity Center's session duration is set to 1 hour.

Self-hosters without a second workload can assign the permission sets to the management account itself instead of a member account; everything below works the same with that account id. The member account is still recommended, because it keeps billing and blast radius separate.

### 3.2 Owner setup, in order

**A. Organization and Identity Center (before M0, in the management account console, signed in as its root user or an existing administrator):**
1. AWS Organizations → **Create an organization** (all features). The existing account becomes the management account; its workloads are not changed. No service control policies are needed.
2. AWS Organizations → **Add an AWS account** → **Create an AWS account**: name `memory-anywhere`, email `you+ma-aws@example.com`. Organizations creates the account and the role `OrganizationAccountAccessRole` in it. Leave the member account's root user without a password; it is used only for break-glass (§5.2) through "Forgot password" on that email.
3. IAM Identity Center → **Enable** in the region the owner prefers for sign-in. Note this region: it is the **Identity Center region** (`sso_region` in part B and the argument of `bootstrap-identity.sh` in §3.3), and it may differ from the deployment region chosen later in M0 Q20. Confirm it shows **organization instance** (if an account instance exists from earlier experiments, delete it first). Settings: identity source "Identity Center directory"; MFA required at every sign-in; session duration 1 hour.
4. Identity Center → **Users** → add `ma-deploy` and `ma-operator` with the two email addresses above. Each user accepts the invitation, sets a password and registers its MFA device.
5. Identity Center → **Permission sets** → **Create permission set** → **Predefined permission set** → `AdministratorAccess`, session duration 1 hour. It exists only for the bootstrap.
6. Identity Center → **AWS accounts** → select `memory-anywhere` → **Assign users or groups** → `ma-operator` → `AdministratorAccess`. This assignment is temporary (removed in step C.5).

**B. PC (before M0).** Install AWS CLI v2 and add to `~/.aws/config` (the whole memory-anywhere part; nothing for the operator; no `region` line until M0 Q20 has chosen one, after which Claude Code tells the owner the line to add):

```ini
[sso-session ma-deploy]
sso_start_url = https://<your-identity-center>.awsapps.com/start
sso_region = <identity-center-region>
sso_registration_scopes = sso:account:access

[profile memory-anywhere-deploy]
sso_session = ma-deploy
sso_account_id = <12-digit memory-anywhere member account id>
sso_role_name = memory-anywhere-deploy
output = json
```

**C. One-time bootstrap (during M0, when Claude Code asks; §3.3).**

**Deploy (PC)**, when Claude Code says a milestone needs one:
1. The owner runs `aws sso login --sso-session ma-deploy --use-device-code`, opens the printed URL in a private window, checks the code and signs in as `ma-deploy` (the `--no-browser` callback flow did not complete from a private window; ADR-0113).
2. Claude Code runs `mema deploy aws … --profile memory-anywhere-deploy --region <region>`.
3. For `prod`, `mema deploy` runs `aws sso logout` when it exits (success or failure), which deletes the cached token. For non-prod stages it keeps the sign-in, which ends with the Identity Center session (12 hours) or `aws sso logout`; it never signs out a session it did not use (spec-issues.md #11). The owner can run `aws sso logout` at any time.

**Operator (CloudShell)**, for the few operator tasks:
1. Open a private browser window, sign in to the access portal as `ma-operator`, choose the `memory-anywhere` account and `memory-anywhere-operator`, open the console, then CloudShell (top bar).
2. First time, and after each script change: get `ma-operator.sh`. In M0 and M1 there is no release yet, so take it from the reviewed commit: `git clone https://github.com/<owner>/memory-anywhere && cd memory-anywhere && git checkout <commit sha the owner reviewed> && git rev-parse HEAD` (the output must equal that SHA), then use `deploy/aws/ma-operator.sh`. From M2, download it from the GitHub release and check its SHA-256 against the release notes. CloudShell keeps `$HOME` between sessions.
3. Run one of:

| Command | Does |
| --- | --- |
| `./ma-operator.sh setup-link [--stage <stage>]` | Prints `https://admin.{host}/setup#<token>` from `<prefix>/setup-token`. If the parameter is missing or the token has expired, it first runs `memory-anywhere-server setup-token --renew` on the instance through SSM Run Command, which issues a fresh 30-minute token (only while the store has no owner, or after an executed owner reset) |
| `./ma-operator.sh set-llm-key [--stage <stage>]` | Reads the key from the terminal (no echo), writes `<prefix>/llm/api_key` as SecureString, and restarts the secrets and server units with SSM Run Command |
| `./ma-operator.sh restore --reason lost\|compromise [--to <timestamp>]` | §5.5 |
| `./ma-operator.sh reset-owner [--cancel]` | Break-glass with a 24-hour delay (auth-and-security.md §3.3) |
| `./ma-operator.sh acme-account` | Prints Caddy's ACME account URI, for the optional CAA `accounturi` hardening (§6.2) |
| `./ma-operator.sh import-export --file <path>` | Moves a full export into a new or rebuilt store (§5.6) |
| `./ma-operator.sh delete-data --stage <stage>` | Non-prod: empties and deletes the stage's backup bucket. Prod: prints the member-account root-user console steps, because only that user may delete object versions or the bucket (§5.2) |

4. Sign out of the portal when done.

### 3.3 One-time bootstrap (owner, during M0, when Claude Code asks)

The deploy permission set cannot create IAM policies, bootstrap CDK or change account defaults, and permission sets live in the management account's Identity Center. So the bootstrap has two scripts, run once, in this order:

1. Claude Code generates and commits `deploy/aws/iam/cfn-exec.json`, `deploy/aws/iam/cfn-exec-services.json` (the execution policy is split in two only because of the 6,144-character managed-policy quota; spec-issues.md #5), `deploy/aws/iam/boundary.json`, `deploy/aws/iam/deploy-permission-set.json`, `deploy/aws/iam/operator-permission-set.json`, `deploy/aws/bootstrap-member.sh` and `deploy/aws/bootstrap-identity.sh`, and shows them to the owner for review.
2. **Member account** (as `ma-operator` with the temporary `AdministratorAccess` assignment, in CloudShell of the `memory-anywhere` account, from the reviewed commit as in §3.2): `bash deploy/aws/bootstrap-member.sh <member account id> <region>`. It:
   - creates the customer-managed policies `memory-anywhere-cfn-exec`, `memory-anywhere-cfn-exec-services` and `memory-anywhere-boundary` from the JSON files;
   - runs `npx aws-cdk@<pinned> bootstrap aws://<account>/<region> --cloudformation-execution-policies arn:aws:iam::<account>:policy/memory-anywhere-cfn-exec,arn:aws:iam::<account>:policy/memory-anywhere-cfn-exec-services`;
   - runs `aws ec2 modify-instance-metadata-defaults --http-tokens required --http-put-response-hop-limit 1 --region <region>`;
   - turns on account-level S3 Block Public Access (all four settings) with `aws s3control put-public-access-block` (§5.2; spec-issues.md #3).
3. **Management account** (signed in to the management account console as root or an existing administrator, CloudShell there, same reviewed commit): `bash deploy/aws/bootstrap-identity.sh <member account id> <identity-center region>`. It sends every `aws sso-admin` and `aws identitystore` call to `--region <identity-center region>` (§3.2 A.3; not the deployment region), first prints that region and the Identity Center instance ARN it found and waits for the owner to type `yes`, and then:
   - creates the permission sets `memory-anywhere-deploy` and `memory-anywhere-operator` (session 1 hour) with their inline policies from the JSON files and **no permissions boundary**. A boundary intersects with the inline policy, so `memory-anywhere-boundary` would strip the sets' own rights (CloudFormation and the CDK roles for deploy; CloudShell and SSM for the operator). Each set is bounded by its own allow list and explicit denies (§3.4);
   - assigns `memory-anywhere-deploy` to `ma-deploy` and `memory-anywhere-operator` to `ma-operator`, on the `memory-anywhere` account only, and provisions them;
   - **removes the `AdministratorAccess` assignment** from `ma-operator` and prints the remaining assignments, which must be exactly those two.
4. The owner may delete the `AdministratorAccess` permission set, or keep it unassigned for a later re-bootstrap.

`memory-anywhere-cfn-exec` allows only the services the stack uses, each scoped to `memory-anywhere-*` / `MemoryAnywhere-*` names where the service supports resource scoping: EC2 (VPC, subnet, route table, internet gateway, VPC endpoint, security group, Elastic IP, instance, launch template, volume and snapshot tags), IAM (roles, instance profiles and policies whose names start with `memory-anywhere-`, only with the permissions boundary `memory-anywhere-boundary` attached; `iam:PassRole` only to `ec2.amazonaws.com` and `dlm.amazonaws.com`), KMS (create key, alias, key policy, grants with `kms:GrantIsForAWSResource`, and `kms:ScheduleKeyDeletion` only for keys whose `memory-anywhere:stage` tag is not `prod`, so destroying a spike or eval stack removes its CMK; spec-issues.md #2), S3 (buckets, bucket policy, lifecycle, versioning, encryption, Object Lock configuration), SSM (parameters under the stage prefix), SNS, CloudWatch Logs, CloudWatch alarms, CloudWatch Logs metric filters, EventBridge rules, CloudTrail, Budgets, Cost Explorer anomaly monitors and subscriptions, DLM, and, only for `--dns route53`, Route 53 record sets in one named hosted zone. No Lambda, no Organizations, no IAM users or access keys.

`memory-anywhere-boundary` caps every role the stack creates at: the instance role actions in §3.5, the DLM role's managed policy, and nothing else. It is attached only to those roles (enforced by the IAM condition in `memory-anywhere-cfn-exec` above), never to the permission sets.

### 3.4 Permission sets

Each is defined on its own; neither inherits the other's statements or explicit denies. Neither has a permissions boundary (§3.3): the allow list and the explicit denies below are the whole scope. Both are assigned only in the `memory-anywhere` member account.

| Permission set | Session | Allows | Explicit denies |
| --- | --- | --- | --- |
| `memory-anywhere-deploy` | 1 hour | `cloudformation:*` on `MemoryAnywhere-*` stacks; `sts:AssumeRole` on the CDK bootstrap roles (`cdk-*-deploy-role-*`, `cdk-*-file-publishing-role-*`, `cdk-*-lookup-role-*`); `s3:PutObject` on releases buckets; `ssm:PutParameter`/`GetParameter` on `/memory-anywhere/release/*` and `/memory-anywhere/acme/*`; for non-prod stages only: `ssm:GetParameter*`/`PutParameter` under `/memory-anywhere-spike/*` and `/memory-anywhere-eval-*/*`, and `s3:ListBucketVersions`, `s3:DeleteObject`, `s3:DeleteObjectVersion` on `memory-anywhere-*-spike` and `memory-anywhere-*-eval-*` buckets (so `mema destroy` can empty them); read-only `ec2:Describe*`, `ec2:GetInstanceMetadataDefaults` (the §7.1 IMDS check; spec-issues.md #4), `cloudformation:Describe*`, `budgets:ViewBudget`; `kms:Decrypt` only with `kms:ViaService = ssm.<region>.amazonaws.com` and `kms:EncryptionContext:PARAMETER_ARN` under `/memory-anywhere-eval-*/`, so the harness reads an eval stack's setup token without the operator (spec-issues #12, #56); for non-prod stages, `ssm:DeleteParameter(s)` under `/memory-anywhere-spike/*` and `/memory-anywhere-eval-*/*` and `ec2:DeleteSnapshot` on snapshots whose `memory-anywhere:stage` tag is not `prod` (destroy cleanup, spec-issues #21) | `ssm:StartSession`, `ssm:SendCommand`; `ssm:GetParameter*` on `/memory-anywhere/llm/*` and `/memory-anywhere/setup-token`; `s3:GetObject*` and every delete on the prod backup and manifest buckets; every other `kms:Decrypt`, `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:PutKeyPolicy`; `iam:*` except what the CDK roles do; `sso:*`, `identitystore:*`, `organizations:*`, `cloudshell:*` |
| `memory-anywhere-operator` | 1 hour | `cloudshell:CreateEnvironment`, `CreateSession`, `StartEnvironment`, `StopEnvironment`, `GetEnvironmentStatus`, `DeleteSession`, `PutCredentials`, `GetFileUploadUrls`, `GetFileDownloadUrls` (resources in this account); `ssm:StartSession`, `ssm:SendCommand` (document `AWS-RunShellScript`), `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations` on instances tagged `memory-anywhere:stage`; `ssm:GetParameter*`, `ssm:PutParameter`, `ssm:DeleteParameter` on `/memory-anywhere/*`, `/memory-anywhere-spike/*` and `/memory-anywhere-eval-*/*`; `s3:GetObject`, `s3:ListBucket`, `s3:ListBucketVersions` on the backup buckets; `s3:PutObject` on the backup buckets' `transfer/*` prefix (§5.6); for non-prod stages only, `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:DeleteBucket` on the spike and eval backup buckets; `kms:Decrypt`, `kms:GenerateDataKey` on the CMKs with `kms:ViaService = s3.<region>.amazonaws.com`; read-only `ec2:Describe*`, `cloudformation:Describe*` | `kms:ScheduleKeyDeletion`; `s3:DeleteObjectVersion` and `s3:DeleteBucket` on the prod backup bucket (member-account root only, §5.2); `iam:*`; `cloudformation:*` writes |

The operator set has no CloudFormation write rights, and the deploy set has no data, session or CloudShell rights. The bucket policy (§5.2) exempts the CDK CloudFormation execution role from its configuration denies so that stack updates work.

### 3.5 Instance role policy

```
ssm:UpdateInstanceInformation, ssmmessages:CreateControlChannel, ssmmessages:CreateDataChannel,
ssmmessages:OpenControlChannel, ssmmessages:OpenDataChannel, ec2messages:*  — required for Session Manager and Run Command
ssm:GetParameter, ssm:GetParameters  — only arn:…:parameter/<stage prefix>/*
ssm:PutParameter, ssm:DeleteParameter — only …/<stage prefix>/setup-token and …/<stage prefix>/acme/account-uri
sns:Publish — only the alerts topic
s3:GetBucketLocation, s3:ListBucket — backup bucket and releases bucket
s3:GetObject, s3:PutObject, s3:DeleteObject — backup bucket prefix litestream/*   (not DeleteObjectVersion)
s3:GetObject, s3:DeleteObject — backup bucket prefix transfer/*   (store import, §5.6)
s3:GetObject — releases bucket
s3:PutObject — manifest bucket prefix manifests/*   (from M4)
kms:GenerateDataKey, kms:Decrypt — the CMK, condition kms:ViaService = s3.<region>.amazonaws.com
logs:CreateLogStream, logs:PutLogEvents — the log group
```

No other actions. In particular no `ssm:GetParameter` on `*` (the managed `AmazonSSMManagedInstanceCore` grants that and is not used; [policy reference](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html)). The role is used only by the root-run agents, Litestream and the `ma-aws` helpers; the server and Caddy users cannot reach IMDS (§4).

### 3.6 KMS key policy

- Account root: full administration (required by KMS), with `kms:ScheduleKeyDeletion` and `DisableKey` alarmed.
- Instance role: `kms:GenerateDataKey`, `kms:Decrypt` with `kms:ViaService = s3.<region>.amazonaws.com` and `kms:EncryptionContext:aws:s3:arn` matching the backup bucket ARN or `arn:…:backup-bucket/*`.
- EBS for the root volume and snapshots, for the principals that launch or restore the instance (the CDK CloudFormation execution role, and the EC2 service acting for it) and for the DLM service role: `kms:CreateGrant` (condition `kms:GrantIsForAWSResource = true`), `kms:GenerateDataKeyWithoutPlaintext`, `kms:Decrypt`, `kms:DescribeKey`, `kms:ReEncrypt*`, all with `kms:ViaService = ec2.<region>.amazonaws.com`. The same statements cover a fresh instance created from a snapshot during a restore.
- Operator permission set: `kms:Decrypt` with `kms:ViaService = s3.<region>.amazonaws.com` (restore).
- Deploy permission set: none (explicit deny in the permission set as well).

## 4. Host configuration

User data (cloud-init) on first boot, idempotent:

1. Create users `memory-anywhere` (no shell), `litestream` (no shell), `ma-aws` (no shell), and `caddy`.
2. Install Node 24 LTS (official tarball, pinned version and SHA-256), Caddy (official arm64 binary, pinned, no plugins), Litestream v0.5.x (official arm64 release, pinned), AWS CLI v2 (pinned), the CloudWatch agent (pinned). Install minisign (official release, aarch64 Linux binary from the pinned version's release archive, SHA-256 pinned in the user data) for release verification (§7.3).
3. Firewall (nftables on AL2023, expressed here as iptables-equivalent rules, persisted):
   ```
   iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner memory-anywhere -j REJECT
   iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner caddy -j REJECT
   ```
   Litestream, `ma-aws`, the SSM agent and the CloudWatch agent (root) keep IMDS access.
4. Caddyfile:
   ```
   {
     admin off
     email <owner email for ACME>
     cert_issuer acme
   }
   {host} {
     reverse_proxy unix//run/memory-anywhere/http.sock {
       header_up X-Forwarded-For {remote_host}
       header_up X-MA-Origin mcp
     }
   }
   admin.{host} {
     reverse_proxy unix//run/memory-anywhere/http.sock {
       header_up X-Forwarded-For {remote_host}
       header_up X-MA-Origin admin
     }
   }
   ```
   `header_up` replaces any client-sent value on **both** sites, so a request to `{host}` can never carry `X-MA-Origin: admin`. The server routes to the admin router only when the value is exactly `admin` (auth-and-security.md §2; eval case S-WEB-05). ACME uses TLS-ALPN-01 on 443 with Let's Encrypt as the only issuer (`cert_issuer acme` uses Let's Encrypt's directory, so Caddy's default ZeroSSL fallback cannot conflict with the CAA record); port 80 stays closed ([Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)).
5. systemd units:

| Unit | User | Purpose |
| --- | --- | --- |
| `memory-anywhere-secrets.service` | `ma-aws` | oneshot before the server: reads `<prefix>/llm/api_key` into `/run/memory-anywhere/secrets.env` (0400, owner `memory-anywhere`) |
| `memory-anywhere.service` | `memory-anywhere` | `memory-anywhere-server start --config /etc/memory-anywhere/server.toml`; hardening per auth-and-security.md §9; `MemorySwapMax=0` (server memory, which holds plaintext, never goes to the swap file); `Restart=always` |
| `litestream.service` | `litestream` | `litestream replicate -config /etc/litestream.yml`; read-write access to the database and its WAL via group `ma-data` (Litestream performs the WAL checkpoints, so it needs write access); `RuntimeDirectory=litestream` (tmpfs `/run/litestream`, mode 0700, removed when the unit stops) holds its metadata and staging files (§5.1); `MemorySwapMax=0`, so those tmpfs pages, which are charged to this unit, never go to swap |
| `ma-updater.timer` / `.service` | root | every 2 minutes, §7.3 |
| `memory-anywhere-outbox.path` / `.service` | `ma-aws` | The server has no AWS credentials, so it writes outbound artifacts to `/run/memory-anywhere/outbox/` (tmpfs, group-writable by `memory-anywhere`, readable by `ma-aws`). The path unit fires on any new file; the service (a fixed script shipped with the release) acts by file-name prefix and then deletes the file: `setup-token` → SSM `<prefix>/setup-token`; `setup-token.delete` → delete that parameter; `alert-<id>.json` → `sns:Publish` to the alerts topic (subject and counts only, no memory content); `acme-account-uri` → SSM `<prefix>/acme/account-uri`; `fetch-<ulid>` → download `s3://<backup bucket>/transfer/<ulid>.age` into the drop directory `/run/memory-anywhere/inbox/drop/` (mode 2770, owner `ma-aws`, group `memory-anywhere`, file mode 0660; the server reads and deletes it there) and delete the object (§5.6); from M4, `manifest-<date>.json` → manifest bucket `manifests/`. Unknown names are deleted and logged |
| `ma-maint.timer` / `.service` | root | At 04:15 owner local time, nightly if `/var/lib/memory-anywhere/maint/purge-pending` exists (written by the server after any purge), and weekly on Sunday regardless. Steps: stop `memory-anywhere.service` and `litestream.service`; run `memory-anywhere-server maint --compact` as user `memory-anywhere`, which checkpoints the WAL into the database, writes a compacted copy with `VACUUM INTO store.new.db`, fsyncs it, overwrites the old `store.db`, `store.db-wal` and `store.db-shm` in place with zeros (`shred -n0 -z -u`), and renames the new file to `store.db`; clear Litestream's metadata directory (`rm -rf /run/litestream/store`; systemd already removes it when the unit stops, and the step makes sure), so Litestream cannot resume from positions recorded for the replaced file; start Litestream (which, with no metadata, takes a new snapshot of the replaced file) and the server; delete the flag. Takes about one to two minutes; requests during it get `STORE_UNAVAILABLE` and coding tools spool. Because the old files are overwritten before they are removed, no purged block remains on the volume for later snapshots |

6. The updater reads Caddy's ACME account URI from Caddy's data directory after the first certificate and writes `acme-account-uri` into the outbox, which stores it in SSM; `./ma-operator.sh acme-account` prints it (§6.2).
7. `/var/lib/memory-anywhere` mode 0770, owner `memory-anywhere`, group `ma-data` (members: `memory-anywhere`, `litestream`); database and WAL files mode 0660. No other user is in `ma-data`.
8. If `/var/lib/memory-anywhere/store.db` does not exist and the backup bucket holds a replica, user data runs `litestream restore -if-db-not-exists -if-replica-exists` before the server starts, and the server starts in *restored* state (§5.5). Otherwise `memory-anywhere-server init` creates a new store.

## 5. Backups, retention and restore

### 5.1 Litestream

`/etc/litestream.yml`, in the v0.5 layout (one `replica:` per database; `snapshot:` is a top-level, global block) ([Litestream config](https://litestream.io/reference/config/)):

```yaml
snapshot:
  interval: 24h
  retention: 168h

dbs:
  - path: /var/lib/memory-anywhere/store.db
    replica:
      type: s3
      bucket: memory-anywhere-backup-<account>-<region>-<stage>
      path: litestream/store
      region: <region>
      sse-kms-key-id: <CMK key ARN>
      sync-interval: 1s
    meta-path: /run/litestream/store
```

- No keys in the file or the environment; the SDK default chain uses the instance role.
- Litestream v0.5 has no `age` encryption and refuses to start with an `age:` block; protection is SSE-KMS plus bucket and key policies.
- Litestream keeps its metadata and local LTX staging files in `meta-path` ([how it works](https://litestream.io/how-it-works/)), set to `/run/litestream/store` on tmpfs (`RuntimeDirectory=litestream` on `litestream.service`, §4). Litestream deletes staging files itself without zeroing them, so they must never reach the EBS volume or its snapshots; on tmpfs they do not. systemd removes the directory whenever Litestream stops, and Litestream then starts with a fresh snapshot. It holds a long-running read transaction so that only it checkpoints the WAL; the server never checkpoints while it runs (data-model.md §1). Purge handling: data-model.md §9 and `ma-maint` (§4).
- M0 Q21 runs this exact file against the pinned release, checks that `meta-path` is honoured (no Litestream file under `/var/lib/memory-anywhere`) and records peak staging size.

### 5.2 Backup bucket policy

- Block Public Access (account and bucket), `BucketOwnerEnforced`, versioning on, default encryption SSE-KMS with the CMK and S3 Bucket Key on.
- Deny any request with `aws:SecureTransport = false`.
- Deny every principal except the instance role, the operator permission-set role, the CDK CloudFormation execution role (`cdk-*-cfn-exec-role-*`) and the account root. On non-prod stages only, the deploy permission-set role is also exempt for `s3:ListBucketVersions`, `s3:DeleteObject` and `s3:DeleteObjectVersion`, so `mema destroy` can empty the bucket (spec-issues.md #1).
- Deny the instance role unless `aws:SourceVpce` = the stack's S3 gateway endpoint (stolen instance credentials do not work off-box).
- Deny `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`, `s3:PutLifecycleConfiguration`, `s3:PutBucketVersioning`, `s3:PutEncryptionConfiguration`, `s3:PutBucketObjectLockConfiguration` to everyone except the account root and the CDK CloudFormation execution role, so stack updates still work; each of those calls raises an immediate alert (§2 EventBridge).
- `prod` only: deny `s3:DeleteObjectVersion` and `s3:DeleteBucket` to every principal except the member account's root user (`aws:PrincipalArn = arn:aws:iam::<member account>:root`). Deleting prod backups is a rare break-glass act: `./ma-operator.sh delete-data --stage prod` prints the steps (sign in to the member account as root through "Forgot password" on its email, add MFA, empty the bucket including versions, delete it, schedule the CMK's deletion). Non-prod stages omit this deny so `mema destroy` and the operator can empty them.
- Deny `s3:PutObject` unless `s3:x-amz-server-side-encryption = aws:kms` and the key id is the CMK.
- Lifecycle: noncurrent versions expire after 14 days; incomplete multipart uploads abort after 1 day.

### 5.3 Retention table

| Copy | Setting | Max age of purged content |
| --- | --- | --- |
| Live DB file | purge with `secure_delete` (freed pages are zeroed in the file when the WAL is checkpointed, which in aws mode Litestream does on its own interval), FTS optimize; rewritten and the old file zeroed by the next `ma-maint` | ≤ Litestream's checkpoint interval (measured in M0 Q21), and ≤ 24 h for every byte |
| Live WAL file | zeroed and replaced by the nightly `ma-maint` after a purge (Litestream blocks application checkpoints) | ≤ 24 h |
| Litestream metadata and local staging (`meta-path` = `/run/litestream/store`, tmpfs) | never written to the volume; cleared whenever Litestream stops (every `ma-maint` run, every reboot) | not on the volume or in EBS snapshots; in memory ≤ 24 h (the nightly `ma-maint` after a purge) |
| Pre-update `pre-<version>.db`, pre-migration `pre-migrate-<n>.db`, pre-restore `pre-restore-<ts>.db` copies | zeroed in place and deleted (`shred -n0 -z -u`) after 24 h of healthy operation (§7.3, operations.md §6) | ≤ 48 h |
| Freed blocks on the EBS volume | Every file on the volume that held plaintext is zeroed in place before deletion (above), and Litestream's own files, which it deletes without zeroing, are on tmpfs, so no freed block keeps purged content; the server never swaps (`MemorySwapMax=0`). S-PURGE scans the raw block device on an eval stack | as the file it belonged to |
| Litestream snapshots and LTX files in S3 | snapshot retention 168 h, then deleted (become noncurrent) | 7 days + 1 day snapshot interval |
| S3 noncurrent versions | expire after 14 days | + 14 days → ≤ 22 days |
| EBS snapshots | daily, keep 7 | ≤ 8 days |
| Manifest bucket (from M4) | hashes only, no personal data | n/a |

Purge guarantee, stated in the README: **purged content is unreadable through the store at once (the purge transaction clears it), gone from every file and from memory on the instance within 48 hours, and from every AWS backup within 30 days** (the computed maximum is 22 days). Copies in Claude, ChatGPT, Gemini or Grok chats and memories are not reached; delete them there. Rationale for 14-day noncurrent expiry: ADR-0012. There is no scheduled export to S3; exports are on demand only (data-model.md §10).

RPO ≈ 1 s (Litestream sync interval) on instance loss. RTO ≤ 30 minutes. The oldest restore point is about 8 days (Litestream snapshots and EBS snapshots).

### 5.4 Integrity

- The `event` table is hash-chained (data-model.md §2); restore verifies the chain.
- From M4: job `manifest` (daily 04:30 UTC) writes `manifest-<date>.json` = `{date, store_id, schema_version, store_hash, event_count, event_chain_head}` to the outbox, which uploads it to the manifest bucket (Object Lock 90 days); restore then also checks it.
- Store hash and content hash: data-model.md §12.

### 5.5 Restore

Two cases:
- **Instance lost or replaced.** The owner (or Claude Code) runs `mema deploy aws --update` with the deploy profile, which recreates the instance. User data finds no database and restores the latest replica (§4 step 8). The server starts in *restored* state: it runs the checks below, rotates `meta.cookie_secret` and `meta.mrtr_key`, revokes all admin sessions, step-up tokens, pending elicitations and pairing windows, keeps OAuth grants, and raises alert `restored`. A revoked token could be resurrected only for the gap between the last backup and the loss (seconds); the alert says so.
- **Point in time or compromise.** The owner runs `./ma-operator.sh restore --reason lost|compromise [--to <timestamp>]` in CloudShell. Through SSM Run Command it stops the server, runs `litestream restore -o /var/lib/memory-anywhere/store.db [-timestamp <ts>] s3://…/litestream/store` (after moving the old file aside under `pre-restore-<ts>.db`, deleted after 24 h like the other copies), and starts the server in restored state. With `--reason compromise`, or a restore point more than 1 hour older than the newest backup, the server also revokes every OAuth grant and the owner re-pairs each app.

Checks in restored state (any failure stops the server and prints the failing check to the journal): `PRAGMA integrity_check` = ok; `schema_version` ≤ the release's; the event hash chain is valid from the first event to the head; from M4, the newest manifest dated ≤ the restore point has its `event_chain_head` at position `event_count` in the restored chain.

The M4 restore drill (DESIGN.md §7) terminates the instance, recreates it with `mema deploy aws --update`, and requires the restored store hash to equal the hash computed just before termination (with writes paused for the drill).

### 5.6 Moving a full export into a store

Used to move the store to a new machine or account with the same `{host}` (topology-and-ipc.md §7), or to rebuild from an export. Exports are age-encrypted to the owner's registered recipient, and the instance holds no age identity, so the file is re-encrypted for a one-time key on the instance:

1. In CloudShell: `./ma-operator.sh import-export --prepare [--stage <stage>]`. Through SSM Run Command, `memory-anywhere-server import-export --prepare` creates a one-time age keypair in `/run/memory-anywhere/inbox/key/` (tmpfs, mode 0700, owner `memory-anywhere`, valid 1 hour; `ma-aws` cannot read it) and prints its public recipient.
2. On the PC (Windows): `cmd /c "age -d -i <owner export identity> export.age | age -r <one-time recipient> -o export.transfer.age"`. Windows PowerShell 5.1 re-encodes native-command pipes and `>` redirection as text, which corrupts binary age output, so the pipe runs in `cmd`; PowerShell 7.4 or later may run the same pipe directly. Either way the result is written with `-o`, never `>`.
3. Upload `export.transfer.age` to CloudShell (Actions → Upload file), then `./ma-operator.sh import-export --file export.transfer.age [--include-auth]`. The script puts it in `s3://<backup bucket>/transfer/<ulid>.age`; the outbox helper (as `ma-aws`) fetches it into `inbox/drop/` (§4) and deletes the S3 object; `memory-anywhere-server import-export --in <file> [--include-auth]` decrypts it with the one-time key, imports it (data-model.md §10: verbatim into an empty store, through the write path at T3 otherwise; `--include-auth` only into an empty store), then zeroes and deletes the file and the one-time key.
4. The server raises alert `store_imported` with the counts.

## 6. Domain, hostname and DNS

### 6.1 Hostname

- `{host}` = `MA_DOMAIN`, a **subdomain** the owner chooses before M0 (examples in this spec use `memory.example.com`). The admin origin is `admin.{host}`. `{host}` never changes after M2 (topology-and-ipc.md §7).
- The value is owner-specific. It lives only in the owner's environment (`MA_DOMAIN`) and in `%APPDATA%\memory-anywhere\deploy.toml` on the PC, never in a repository file. The CDK app takes it as a runtime parameter and writes it to no committed file (`cdk.context.json` holds only the AMI pin). CI fails if any committed file contains the value of the repository secret `OWNER_HOST` (a grep step that prints only "found" or "not found").
- The hostname is published in Certificate Transparency logs when Caddy gets its certificate. That is expected: the hostname is **not a secret**, and nothing in the design relies on it being unknown. Every protection is in authentication and pairing (auth-and-security.md §4).
- M0 uses `spike.{host}`; eval stacks use `eval.{host}` and `admin.eval.{host}`.

### 6.2 Records (owner path: DNS at Cloudflare, records added by hand)

The owner's DNS zone is at Cloudflare and hosts other services. memory-anywhere uses only names under `{host}`; it never touches the apex or any existing record, and it holds no Cloudflare credential.

After `mema deploy aws` creates the Elastic IP, it prints the exact records and waits until public DNS resolves both names to the Elastic IP:

| Name | Type | Value | Cloudflare setting |
| --- | --- | --- | --- |
| `memory` (that is, `{host}`) | A | the Elastic IP | **DNS only (grey cloud)**, TTL Auto |
| `admin.memory` (that is, `admin.{host}`) | A | the Elastic IP | **DNS only (grey cloud)**, TTL Auto |
| `memory` | CAA | `0 issue "letsencrypt.org"` | — |

- **DNS only, never proxied.** A proxied (orange-cloud) record would end TLS at Cloudflare, so Cloudflare would see OAuth tokens and memory content, and its 100-second proxy timeout would cut long-lived MCP streams. `mema doctor` and `mema deploy` check that both names resolve to the Elastic IP itself (not a Cloudflare address) and fail otherwise.
- **Two A records, not one.** The admin UI must be a separate origin from `/mcp` and the OAuth pages (auth-and-security.md §2, §8), so it needs its own name. A wildcard `*.memory` record would also work but would cover names the project never uses, so two explicit records are preferred (ADR-0024).
- **Certificates.** Caddy obtains them itself from Let's Encrypt with the TLS-ALPN-01 challenge on port 443 (port 80 stays closed, so HTTP-01 is not used). The Caddyfile sets Let's Encrypt as the only issuer (`cert_issuer acme`, §4) so the CAA record matches.
- **CAA on the subdomain only.** CAA is looked up at the exact name first and then up the tree, and the first record set found applies (RFC 8659), so a CAA record at `memory` governs `memory`, `admin.memory`, `spike.memory` and `eval.memory`, and leaves the apex's own certificate setup untouched. Optional hardening, after the first prod certificate: `./ma-operator.sh acme-account` prints Caddy's ACME account URI, and the owner may replace the record value with `0 issue "letsencrypt.org; accounturi=<uri>; validationmethods=tls-alpn-01"` (RFC 8657; Let's Encrypt honours both parameters, and they work on a subdomain record like any other). Because a replaced instance creates a new ACME account, the owner must relax the record back to `0 issue "letsencrypt.org"` before replacing the prod instance or deploying a spike or eval stack, and `mema deploy` warns about this. With `accounturi` on, an **unplanned** replacement (instance lost, or the M4 drill) cannot get a certificate until the owner relaxes the record in Cloudflare, so the restore time then includes that manual DNS edit; the RTO in §5.3 assumes `accounturi` is off. Without accounturi the main protection against a reused IP is the retained Elastic IP and the teardown order below.
- DNSSEC is whatever the owner already runs at Cloudflare; memory-anywhere adds no requirement.

### 6.3 Teardown and dangling DNS

A record that still points at a released Elastic IP would let whoever gets that IP next obtain a certificate for `{host}` and receive the tokens vendor clouds send. So:
- The prod Elastic IP is never released while the stack exists; replacing or restoring the instance keeps the same IP and needs no DNS change.
- `mema destroy aws --stage <stage>` (manual DNS) prints the records to delete in Cloudflare, waits until public DNS no longer resolves them to the Elastic IP (checked every 30 s), and only then releases the Elastic IP and deletes the stack. It never releases the IP while a record still resolves to it.
- Spike and eval names (`spike.memory`, `eval.memory`, `admin.eval.memory`) are added before and deleted after each such stack, with the same check.
- For `prod`, the backup bucket is retained; deleting it is the operator's `delete-data` command. Non-prod buckets are emptied by `mema destroy`.

### 6.4 Route 53 option (other self-hosters)

With `--dns route53 --hosted-zone-id <id>`, the stack creates the A and CAA records itself in an existing Route 53 hosted zone (TTL 300), and `mema destroy aws` deletes them, waits 300 s, then releases the Elastic IP. The cfn-exec policy includes Route 53 record-set permissions only for that zone. The owner does not use this option.

## 7. Deploy commands

### 7.1 First deploy (`mema deploy aws --stage prod --profile memory-anywhere-deploy --region <region>`, domain from `MA_DOMAIN`)

1. Checks: `MA_DOMAIN` set (and, for `--dns route53`, the hosted zone exists); the CDK bootstrap is present with the custom execution policy and the IMDS account default is set (else it prints "run the one-time bootstrap, §3.3" and stops).
2. `cdk deploy` with the stack parameters. Prints the diff first; `--yes` skips the prompt only for non-prod stages.
3. Uploads the release tarball to the releases bucket and sets `<prefix>/release/desired` = `{version, sha256}`. For `prod` the tarball must be a CI-signed GitHub release (§7.4); for `spike` and `eval-*` it may be `--release-file <tarball>` signed with the dev key.
4. With `--dns manual`, prints the records of §6.2 for the new Elastic IP and waits until both names resolve to it (DNS only). Then waits until `https://{host}/v1/health` returns the expected version (timeout 15 minutes after DNS resolves).
5. Runs `aws sso logout` (prod; non-prod keeps the sign-in, §3.2 C) and tells the owner to open CloudShell as `ma-operator` and run `./ma-operator.sh setup-link` and `./ma-operator.sh set-llm-key` (§3.2).

### 7.2 Updates (`mema deploy aws --update [--release <version> | --release-file <tarball>]`)

Infrastructure changes run `cdk deploy`. Application releases are pulled by the instance (no `ssm:SendCommand` needed by the deploy profile). `--release <version>` downloads `memory-anywhere-server-<version>.tar.gz` and its `.minisig` from the GitHub release `v<version>`, verifies them with `deploy/aws/release-keys/release.pub` on the PC, then uploads them unchanged; the spike, which trusts only the dev key, refuses it. A prod update whose `cdk diff` replaces the instance stops unless `--allow-replace` is given (the store then comes back from the backup, §5.5). Every deploy warns when `{host}` has no CAA record naming only Let's Encrypt (§6.2). `mema deploy` always signs out of the SSO session on exit.

### 7.3 Updater (`ma-updater.service`, root, every 2 minutes)

1. Read `<prefix>/release/desired` `{version, sha256}`. If equal to `/opt/memory-anywhere/current/VERSION`, go to step 7.
2. Download the tarball and its `.minisig` from the releases bucket; verify its SHA-256, then run `minisign -V -p /etc/memory-anywhere/release-keys/<key>.pub -m <tarball>` for each key trusted by the stage (§7.4), using the minisign binary installed in §4 step 2. Refuse unless one key verifies.
3. Copy the database with the SQLite online backup API (`memory-anywhere-server backup --out /var/lib/memory-anywhere/pre-<version>.db`). The daily EBS snapshot and Litestream cover older points; the updater has no EC2 permissions.
4. Unpack to `/opt/memory-anywhere/releases/<version>`. The tarball already contains `node_modules` with the linux-arm64 prebuilt natives, built in CI; nothing is installed on the instance.
5. Stop the server; run `memory-anywhere-server migrate` (which makes its own `pre-migrate-<n>.db`); switch the `current` symlink; start the server.
6. Check `/v1/health` over the socket within 60 s. On failure: stop, restore `pre-<version>.db`, switch the symlink back, start, and raise alert `update_failed`.
7. Once an hour: resolve `{host}` and `admin.{host}` with DNS over HTTPS on port 443 (the security group allows no port 53), using the resolver URL pinned in `/etc/memory-anywhere/server.toml` `[deployment] doh_url` (default `https://cloudflare-dns.com/dns-query`), and compare with the Elastic IP; on a mismatch write `alert-dns_mismatch.json` to the outbox.
8. Housekeeping on every run: zero in place and delete (`shred -n0 -z -u`) `pre-*.db`, `pre-migrate-*.db` and `pre-restore-*.db` files whose release or restore has passed health checks continuously for 24 hours; keep the previous two release directories and delete older ones.

### 7.4 Release signing

| Key | Generated by | Private half | Public half | Trusted by |
| --- | --- | --- | --- | --- |
| Release key | The owner, once, before M2, on the PC: `minisign -G -W -p release.pub -s release.key` (no password: CI cannot type one, and the key is protected instead by the GitHub environment's manual approval) | GitHub Actions environment secret `RELEASE_MINISIGN_KEY` in environment `release` (manual approval required, admins included), plus an offline copy in the owner's password manager; the local file is deleted after upload | Committed as `deploy/aws/release-keys/release.pub` | `prod`, `eval-*` |
| Dev key | Claude Code in M0 (`minisign -G -W`, no password) | `{data}\dev-release.key` on the PC, never committed | Committed as `deploy/aws/release-keys/dev.pub` | `spike`, `eval-*` only |

- From M2, a tag-triggered workflow builds the server tarball for linux-arm64 in CI, signs it with the release key, and publishes it as a GitHub release with its SHA-256 (npm publishing comes in M5).
- `mema deploy aws --release-file <tarball>` signs a local build with the dev key; the CDK app installs `dev.pub` only on `spike` and `eval-*` instances, so a dev-signed build cannot run on `prod` without a stack change, which is alerted (§2).
- Rotation: a new key's public half is committed, deployed with `--update`, and the old one removed in the next release.

## 8. Eval stacks

Eval stacks create no cost-anomaly monitor (prod's covers the account) and run `memory-anywhere-server selfcheck` from `ma-maint` (spec-issues #56, #57).

`mema deploy aws --stage eval-<id>` creates a separate stack with the hostnames `eval.{host}` and `admin.eval.{host}` (the owner adds and later deletes their DNS-only A records, §6.3; one eval stack at a time), and its own issuer, store, buckets and CMK. Eval stacks never share any resource with `prod`. Their SSM parameters live under `/memory-anywhere-eval-<id>/`, which the deploy permission set may read and write (setup token, LLM key), so the harness can bootstrap an eval stack without the operator user. Eval data is synthetic. `mema destroy aws --stage eval-<id>` runs after each eval campaign and empties the stack's buckets.

## 9. M0 spike stack

`--stage spike` uses the same CDK app with: hostname `spike.{host}` (one DNS-only A record the owner adds in M0 and deletes at the end of M0; the stub serves its test pages on that one name), the M0 stub server shipped as a dev-signed `--release-file`, Litestream and `ma-maint` exactly as in §4–§5.1 against the spike backup bucket, with `spikes/litestream-probe` standing in for the server's database and its `maint --compact` step (M0 Q21 measures them there), parameters under `/memory-anywhere-spike/`. It is destroyed (DNS first, buckets emptied) at the end of M0. M2 deploys `prod` with fresh secrets; no M0 grant, passkey or token carries over.

## 10. Cost

On-demand, us-east-1 prices from the reviews; measured in M4 before the README states a number.

| Line item | Monthly |
| --- | --- |
| t4g.small ($0.0168/h; [Vantage](https://instances.vantage.sh/aws/ec2/t4g.small)); free for 750 h/month until Dec 31 2026 ([T4g](https://aws.amazon.com/ec2/instance-types/t4/)) | $12.26 |
| Public IPv4 / Elastic IP in use ($0.005/h; [VPC pricing](https://aws.amazon.com/vpc/pricing/)) | $3.65 |
| EBS gp3 20 GiB | ≈ $1.60 |
| EBS snapshots (7 daily, incremental) | < $0.30 |
| KMS customer-managed key | $1.00 |
| S3 storage and requests (backup, releases; manifest from M4) | < $0.50 |
| CloudWatch Logs (≤ 0.5 GB) and 3 metric-filter metrics | ≈ $1.20 |
| CloudTrail management events and releases-bucket data events, Budgets, Cost Anomaly Detection, SNS email, S3 gateway endpoint | ≈ $0 |
| **Total** | **≈ $20.50** |
| DNS | $0 for the owner (existing Cloudflare zone); a Route 53 hosted zone adds $0.50 ([pricing](https://aws.amazon.com/route53/pricing/)) for self-hosters who use `--dns route53` |

Ways under $20, decided in M4 from the measured bill: a 1-year Compute Savings Plan; `t4g.micro` if M0 Q14 shows total RSS fits in 1 GiB with swap; dropping the metric filters. The budget alerts ($25 forecast, $30 actual) are revisited after M4.

## 11. Region

Chosen in M0 Q20 by median RTT from the owner's PC to `us-east-1` and `us-east-2` (and `us-west-2` as a control), measured with 50 TLS handshakes each to an S3 endpoint. Ties go to `us-east-1`. The region is fixed for the `prod` stack.
