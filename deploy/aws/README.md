# deploy/aws

The AWS side of memory-anywhere: the CloudFormation stack (built with the CDK), what runs on the machine,
and the IAM policies that limit who may change either. Users never run this folder directly: `mema deploy
aws` and `mema destroy aws` drive it, from a checkout or from the installed npm package. How to use it:
[Guide 04 · Your own AWS](../../docs/guide/04-your-own-aws.md). The rules it implements:
[deployment-aws](../../docs/design/spec/deployment-aws.md).

## The picture

Three layers, each changed by a different hand:

```
  account setup      bootstrap-*.sh, iam/         once, by the owner in CloudShell
       │
  the stack          bin/app.ts, lib/             each deploy, by `mema deploy aws` (deploy role)
       │
  the machine        host/                        first boot, then the updater every 2 minutes
```

A client computer can deploy the stack but cannot read the backups; the operator script runs only in CloudShell;
the machine holds no AWS credentials beyond its own role.

## Files

| Path | What it is |
| --- | --- |
| `bin/app.ts` | The CDK app: reads the stage's inputs and builds the stack |
| `lib/stack.ts` | The stack, composed from `lib/stack/`: `network`, `storage` (key, buckets, backup protection), `instance`, `alerts`, `audit` |
| `lib/inputs.ts`, `lib/names.ts` | Stage inputs (region, AMI pins, release keys, instance generation) and every resource name |
| `lib/user-data.ts` | The first-boot user data, within EC2's 16 KB limit |
| `lib/dir.ts` | Where the CDK app and its workspace live, from a checkout or from the npm package |
| `host/` | First boot, the updater and its timer, pinned binary hashes; the signed release installs the rest |
| `iam/` | The permissions boundary, the CloudFormation execution role, and the deploy and operator permission sets |
| `bootstrap-member.sh`, `bootstrap-identity.sh` | One-time account setup, run in CloudShell |
| `ma-operator.sh` | Operator commands, CloudShell only: pause and resume, store hash, setup link, LLM key, restore, owner reset, importing an export, deleting data |
| `release-keys/` | Public keys the machine trusts for signed releases |
| `test/` | Stack, IAM and operator-script tests |

## Changing the stack

Every construct is added to the one stack scope, so its CloudFormation logical id comes from its name. A
changed id makes CloudFormation delete the resource and create a new one, which on prod means a new
machine, key or bucket. `test/stack.test.ts` pins every stage's logical ids in a snapshot: if it fails,
either restore the id or, for an intended replacement, update the snapshot (`npx vitest run -u
deploy/aws`) and say why in the commit.

```sh
pnpm test deploy/aws
```
