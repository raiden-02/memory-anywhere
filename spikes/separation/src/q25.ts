// Q25 (m0-spike.md): with only ma-deploy signed in on this PC, can anything reach
// operator rights or an account other than memory-anywhere?
//
// Usage (after the owner ran `aws sso login --sso-session ma-deploy`):
//   node spikes/separation/src/q25.ts --label pre-stack [--stage spike]
// Writes docs/results/evidence/ADR-0113/q25-<label>.json (scrubbed) and always
// signs out at the end, then checks that no SSO token or role credential is cached.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scrub } from "../../../scripts/scrub-evidence.ts";
import { classify, judge, type Expectation, type Outcome, type Verdict } from "./classify.ts";

const PROFILE = "memory-anywhere-deploy";
const SSO_SESSION = "ma-deploy";
const REGION = "us-east-1";
const CDK_QUALIFIER = "hnb659fds";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CheckRecord {
  name: string;
  as: "ma-deploy" | "cdk-lookup-role";
  command: string;
  expect: Expectation | "custom";
  outcome: Outcome;
  verdict: Verdict;
  detail: string;
}

function aws(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile("aws", args, { env, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function ssoCacheDir(): string {
  return join(homedir(), ".aws", "sso", "cache");
}

/** The CLI stores an sso-session token under sha1(<session name>).json. */
function readAccessToken(): string {
  const file = join(ssoCacheDir(), `${createHash("sha1").update(SSO_SESSION).digest("hex")}.json`);
  const token = (JSON.parse(readFileSync(file, "utf8")) as { accessToken?: string }).accessToken;
  if (!token) throw new Error(`no SSO token cached for ${SSO_SESSION}: run aws sso login --sso-session ${SSO_SESSION}`);
  return token;
}

/** Names of cached files that still hold an SSO access token or role credentials. */
function cachedSecrets(): string[] {
  const found: string[] = [];
  for (const dir of [ssoCacheDir(), join(homedir(), ".aws", "cli", "cache")]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const text = readFileSync(join(dir, name), "utf8");
      if (/"accessToken"|"SecretAccessKey"|"refreshToken"/.test(text)) found.push(join(dir, name));
    }
  }
  return found;
}

function shown(args: string[]): string {
  return ["aws", ...args].join(" ").replace(/--access-token \S+/, "--access-token <token>");
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { label: { type: "string" }, stage: { type: "string", default: "spike" } } });
  const label = values.label;
  if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("--label <lowercase-name> is required");
  const domain = process.env["MA_DOMAIN"] ?? "";
  if (!domain) throw new Error("MA_DOMAIN is not set (needed to scrub the evidence)");

  const records: CheckRecord[] = [];
  const asDeploy = ["--profile", PROFILE, "--region", REGION];

  async function check(
    name: string,
    args: string[],
    expect: Expectation,
    as: CheckRecord["as"] = "ma-deploy",
    env?: NodeJS.ProcessEnv,
  ): Promise<CliResult> {
    const r = await aws(args, env);
    const outcome = classify(r.exitCode, r.stderr);
    records.push({ name, as, command: shown(args), expect, outcome, verdict: judge(expect, outcome), detail: r.stderr || r.stdout });
    return r;
  }

  try {
    const who = await aws(["sts", "get-caller-identity", ...asDeploy]);
    if (who.exitCode !== 0) throw new Error(`not signed in: ${who.stderr}`);
    const caller = JSON.parse(who.stdout) as { Account: string; Arn: string };
    const acct = caller.Account;
    records.push({
      name: "caller is the deploy permission set in the member account",
      as: "ma-deploy",
      command: shown(["sts", "get-caller-identity", ...asDeploy]),
      expect: "custom",
      outcome: "allowed",
      verdict: /assumed-role\/AWSReservedSSO_memory-anywhere-deploy_[0-9a-f]+\/ma-deploy$/.test(caller.Arn) ? "pass" : "fail",
      detail: caller.Arn,
    });

    // 1. Which accounts and roles can this sign-in reach at all?
    const token = readAccessToken();
    const accounts = await aws(["sso", "list-accounts", "--access-token", token, "--region", REGION]);
    const accountList = accounts.exitCode === 0 ? (JSON.parse(accounts.stdout) as { accountList: { accountId: string; accountName: string }[] }).accountList : [];
    records.push({
      name: "only the memory-anywhere account is listed",
      as: "ma-deploy",
      command: shown(["sso", "list-accounts", "--access-token", token, "--region", REGION]),
      expect: "custom",
      outcome: classify(accounts.exitCode, accounts.stderr),
      verdict: accountList.length === 1 && accountList[0]?.accountId === acct && accountList[0]?.accountName === "memory-anywhere" ? "pass" : "fail",
      detail: JSON.stringify(accountList.map((a) => ({ accountId: a.accountId, accountName: a.accountName }))),
    });
    for (const a of accountList) {
      const rolesArgs = ["sso", "list-account-roles", "--access-token", token, "--account-id", a.accountId, "--region", REGION];
      const roles = await aws(rolesArgs);
      const roleNames = roles.exitCode === 0 ? (JSON.parse(roles.stdout) as { roleList: { roleName: string }[] }).roleList.map((r) => r.roleName) : [];
      records.push({
        name: `only the deploy role is listed on ${a.accountName}`,
        as: "ma-deploy",
        command: shown(rolesArgs),
        expect: "custom",
        outcome: classify(roles.exitCode, roles.stderr),
        verdict: roleNames.length === 1 && roleNames[0] === "memory-anywhere-deploy" ? "pass" : "fail",
        detail: JSON.stringify(roleNames),
      });
    }

    // 2. Operator actions: shell, commands, secrets, backups. Instance ids are
    // placeholders: an explicit deny is evaluated before the target is looked up.
    const instance = "i-0123456789abcdef0";
    await check("ssm start-session is denied", ["ssm", "start-session", "--target", instance, ...asDeploy], "denied");
    await check(
      "ssm send-command is denied",
      ["ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript", "--parameters", "commands=id", ...asDeploy],
      "denied",
    );
    await check("prod setup token is denied", ["ssm", "get-parameter", "--name", "/memory-anywhere/setup-token", "--with-decryption", ...asDeploy], "denied");
    await check("prod LLM key is denied", ["ssm", "get-parameter", "--name", "/memory-anywhere/llm/api_key", "--with-decryption", ...asDeploy], "denied");
    const stagePrefix = `/memory-anywhere-${values.stage}`;
    await check(
      `${values.stage} setup token cannot be decrypted`,
      ["ssm", "get-parameter", "--name", `${stagePrefix}/setup-token`, "--with-decryption", ...asDeploy],
      "deniedOrMissing",
    );
    for (const stage of ["prod", values.stage]) {
      const bucket = `memory-anywhere-backup-${acct}-${REGION}-${stage}`;
      await check(`${stage} backup bucket cannot be read`, ["s3", "cp", `s3://${bucket}/litestream/q25-probe`, "-", ...asDeploy], "deniedOrMissing");
    }

    // 3. Nothing else in or beyond the account.
    await check(
      "OrganizationAccountAccessRole cannot be assumed",
      ["sts", "assume-role", "--role-arn", `arn:aws:iam::${acct}:role/OrganizationAccountAccessRole`, "--role-session-name", "q25", ...asDeploy],
      "denied",
    );
    await check("IAM is denied", ["iam", "list-users", ...asDeploy], "denied");
    await check("Organizations is denied", ["organizations", "describe-organization", ...asDeploy], "denied");
    await check("Identity Center admin is denied", ["sso-admin", "list-instances", ...asDeploy], "denied");
    await check("KMS key listing is denied", ["kms", "list-keys", ...asDeploy], "denied");

    // 4. The CDK lookup role is ReadOnlyAccess minus kms:Decrypt; it must not
    // reach secrets or backups either (they are KMS-encrypted).
    const lookupArn = `arn:aws:iam::${acct}:role/cdk-${CDK_QUALIFIER}-lookup-role-${acct}-${REGION}`;
    const assumed = await check(
      "deploy can assume the CDK lookup role (expected: CDK needs it)",
      ["sts", "assume-role", "--role-arn", lookupArn, "--role-session-name", "q25-lookup", ...asDeploy],
      "allowed",
    );
    if (assumed.exitCode === 0) {
      const assumeRecord = records.at(-1);
      if (assumeRecord) assumeRecord.detail = "assumed (credentials not recorded)";
      const c = (JSON.parse(assumed.stdout) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } }).Credentials;
      const env: NodeJS.ProcessEnv = { ...process.env, AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken };
      delete env["AWS_PROFILE"];
      const r = ["--region", REGION];
      await check("lookup role: prod setup token", ["ssm", "get-parameter", "--name", "/memory-anywhere/setup-token", "--with-decryption", ...r], "deniedOrMissing", "cdk-lookup-role", env);
      await check(
        `lookup role: ${values.stage} setup token`,
        ["ssm", "get-parameter", "--name", `${stagePrefix}/setup-token`, "--with-decryption", ...r],
        "deniedOrMissing",
        "cdk-lookup-role",
        env,
      );
      for (const stage of ["prod", values.stage]) {
        const bucket = `memory-anywhere-backup-${acct}-${REGION}-${stage}`;
        await check(`lookup role: ${stage} backup bucket`, ["s3", "cp", `s3://${bucket}/litestream/q25-probe`, "-", ...r], "deniedOrMissing", "cdk-lookup-role", env);
      }
      await check("lookup role: ssm start-session", ["ssm", "start-session", "--target", instance, ...r], "denied", "cdk-lookup-role", env);
    }
  } finally {
    // 5. Sign out, then confirm nothing usable is left on disk.
    const out = await aws(["sso", "logout", "--profile", PROFILE]);
    const left = cachedSecrets();
    records.push({
      name: "aws sso logout leaves no token or role credentials cached",
      as: "ma-deploy",
      command: "aws sso logout --profile memory-anywhere-deploy; scan ~/.aws/sso/cache and ~/.aws/cli/cache",
      expect: "custom",
      outcome: out.exitCode === 0 ? "allowed" : "error",
      verdict: out.exitCode === 0 && left.length === 0 ? "pass" : "fail",
      detail: left.length === 0 ? "no cached token or credentials" : `still cached: ${left.join(", ")}`,
    });
  }

  const summary = { pass: 0, fail: 0, pending: 0 };
  for (const r of records) summary[r.verdict]++;
  const report = { question: "Q25", label, stage: values.stage, ranAt: new Date().toISOString(), summary, checks: records };
  const here = dirname(fileURLToPath(import.meta.url));
  const outFile = join(here, "..", "..", "..", "docs", "results", "evidence", "ADR-0113", `q25-${label}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, scrub(JSON.stringify(report, null, 2) + "\n", { domain }).text);

  for (const r of records) console.log(`${r.verdict.toUpperCase().padEnd(7)} [${r.as}] ${r.name} (${r.outcome})`);
  console.log(`\n${summary.pass} pass, ${summary.fail} fail, ${summary.pending} pending -> ${outFile}`);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
