// mema deploy aws / mema destroy aws (deployment-aws.md §6.2, §6.3, §7.1, §7.4;
// config-and-cli.md §4).
//
// Every AWS call uses the deploy SSO profile. The owner's hostname comes only
// from MA_DOMAIN and goes to CloudFormation as a parameter. Both commands always
// end with `aws sso logout`, success or failure.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMI_CONTEXT_KEY, AMI_SSM_PARAMETER, CDK_CLI, CDK_CONTEXT_FILE, DEPLOY_AWS_DIR } from "@memory-anywhere/deploy-aws/dir";
import {
  CDK_QUALIFIER,
  parameterPrefix,
  parseStage,
  stackName,
  stageHost,
  stageHostnames,
  type Stage,
} from "@memory-anywhere/deploy-aws/names";
import { caaAllowsOnlyLetsEncrypt, classifyName, resolveA, resolveCaa, type Fetch } from "./dns.ts";
import { DeployError, must, systemTar, type Runner } from "./process.ts";

export interface Deps {
  run: Runner;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  /** Path of the dev minisign secret key ({data}/dev-release.key). */
  devKeyFile: string;
  readText: (path: string) => Promise<string>;
  writeText: (path: string, text: string) => Promise<void>;
  sha256File: (path: string) => Promise<string>;
  /** Writes text to a new private temporary file, passes its path to use, then deletes it. */
  withTempFile: <T>(text: string, use: (path: string) => Promise<T>) => Promise<T>;
  /** Passes a new private temporary directory to use, then deletes it. */
  withTempDir: <T>(use: (dir: string) => Promise<T>) => Promise<T>;
  /** Downloads `url` (https only) to `file`; throws on any HTTP error. */
  download: (url: string, file: string) => Promise<void>;
}

export const defaultFileDeps = {
  readText: (p: string) => readFile(p, "utf8"),
  writeText: (p: string, t: string) => writeFile(p, t, "utf8"),
  sha256File: (p: string) =>
    new Promise<string>((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(p)
        .on("data", (d) => h.update(d))
        .on("error", reject)
        .on("end", () => resolve(h.digest("hex")));
    }),
  withTempDir: async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "mema-"));
    try {
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  download: async (url: string, file: string): Promise<void> => {
    if (!url.startsWith("https://")) throw new DeployError(`refusing to download over plain HTTP: ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new DeployError(`download of ${url} failed: HTTP ${res.status}`);
    await writeFile(file, new Uint8Array(await res.arrayBuffer()));
  },
  withTempFile: async <T>(text: string, use: (path: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "mema-"));
    try {
      const file = join(dir, "payload.json");
      await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
      return await use(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export interface CommonOptions {
  stage: string;
  region: string;
  profile: string;
}

export interface DeployOptions extends CommonOptions {
  update: boolean;
  releaseFile?: string;
  release?: string;
  yes: boolean;
  dns: string;
  alertEmail?: string;
  /** Lets an update replace prod's instance (its disk and store are rebuilt from the backup). */
  allowReplace?: boolean;
}

/** Where CI publishes signed server releases (deployment-aws.md §7.4). */
export const RELEASE_REPO = "raiden-02/memory-anywhere";
export const releaseAsset = (version: string): string => `memory-anywhere-server-${version}.tar.gz`;
export const releaseUrl = (version: string, asset: string): string => `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${asset}`;
/** The CI release key's public half, trusted by prod and eval stacks. */
export const RELEASE_PUB = join(DEPLOY_AWS_DIR, "release-keys", "release.pub");

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const DNS_POLL_MS = 30_000;
const DNS_TIMEOUT_MS = 60 * 60_000;
const HEALTH_TIMEOUT_MS = 15 * 60_000;

interface Context {
  stage: Stage;
  host: string;
  account: string;
  aws: (what: string, args: string[]) => Promise<string>;
}

// ---------------------------------------------------------------- preflight

function requireHost(env: Deps["env"]): string {
  const host = (env["MA_DOMAIN"] ?? "").trim().toLowerCase();
  if (!host) throw new DeployError("MA_DOMAIN is not set: set it to your memory-anywhere subdomain (config-and-cli.md §5)");
  if (!HOST.test(host)) throw new DeployError("MA_DOMAIN is not a DNS name");
  return host;
}

/** Set once the SSO session has answered: from then on, exiting signs it out. */
interface Session {
  used: boolean;
}

async function begin(opts: CommonOptions, deps: Deps, session: Session): Promise<Context> {
  const stage = (() => {
    try {
      return parseStage(opts.stage);
    } catch (e) {
      throw new DeployError((e as Error).message);
    }
  })();
  const host = requireHost(deps.env);
  const base = ["--profile", opts.profile, "--region", opts.region, "--output", "json"];
  const aws = (what: string, args: string[]) => must(deps.run, what, "aws", [...args, ...base]);

  const who = JSON.parse(await aws("checking the SSO sign-in (run: aws sso login --sso-session ma-deploy --use-device-code)", ["sts", "get-caller-identity"])) as {
    Account: string;
    Arn: string;
  };
  session.used = true;
  if (!/:assumed-role\/AWSReservedSSO_memory-anywhere-deploy_[0-9a-f]+\//.test(who.Arn)) {
    throw new DeployError(`profile ${opts.profile} is not signed in with the memory-anywhere-deploy permission set`);
  }
  return { stage, host, account: who.Account, aws };
}

async function checkBootstrap(ctx: Context, region: string): Promise<void> {
  const toolkit = (await ctx
    .aws("reading the CDK bootstrap", ["cloudformation", "describe-stacks", "--stack-name", "CDKToolkit"])
    .catch(() => "")) as string;
  const params = toolkit ? ((JSON.parse(toolkit) as { Stacks: { Parameters?: { ParameterKey: string; ParameterValue: string }[] }[] }).Stacks[0]?.Parameters ?? []) : [];
  const policies = params.find((p) => p.ParameterKey === "CloudFormationExecutionPolicies")?.ParameterValue ?? "";
  const qualifier = params.find((p) => p.ParameterKey === "Qualifier")?.ParameterValue ?? "";
  const expected = [`arn:aws:iam::${ctx.account}:policy/memory-anywhere-cfn-exec`, `arn:aws:iam::${ctx.account}:policy/memory-anywhere-cfn-exec-services`];
  if (!toolkit || qualifier !== CDK_QUALIFIER || !expected.every((p) => policies.split(",").includes(p))) {
    throw new DeployError(`the CDK bootstrap in ${region} is missing or does not use the memory-anywhere execution policies: run the one-time bootstrap (deployment-aws.md §3.3)`);
  }
  const imds = JSON.parse(await ctx.aws("reading the IMDS account default", ["ec2", "get-instance-metadata-defaults"])) as {
    AccountLevel?: { HttpTokens?: string; HttpPutResponseHopLimit?: number };
  };
  if (imds.AccountLevel?.HttpTokens !== "required" || imds.AccountLevel.HttpPutResponseHopLimit !== 1) {
    throw new DeployError("the account IMDS default is not IMDSv2 with hop limit 1: run the one-time bootstrap (deployment-aws.md §3.3)");
  }
}

/** The AMI is resolved once per region and then pinned in cdk.context.json (deployment-aws.md §2). */
async function pinnedAmi(ctx: Context, region: string, deps: Deps): Promise<string> {
  let context: Record<string, unknown> = {};
  try {
    context = JSON.parse(await deps.readText(CDK_CONTEXT_FILE)) as Record<string, unknown>;
  } catch {
    // no file yet
  }
  const pins = (context[AMI_CONTEXT_KEY] ?? {}) as Record<string, string>;
  if (pins[region]) return pins[region];

  // Public parameter, readable only through the CDK lookup role (ReadOnlyAccess).
  const role = `arn:aws:iam::${ctx.account}:role/cdk-${CDK_QUALIFIER}-lookup-role-${ctx.account}-${region}`;
  const creds = (JSON.parse(await ctx.aws("assuming the CDK lookup role", ["sts", "assume-role", "--role-arn", role, "--role-session-name", "mema-ami-pin"])) as {
    Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string };
  }).Credentials;
  const r = await deps.run("aws", ["ssm", "get-parameter", "--name", AMI_SSM_PARAMETER, "--region", region, "--query", "Parameter.Value", "--output", "text"], {
    env: { AWS_ACCESS_KEY_ID: creds.AccessKeyId, AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey, AWS_SESSION_TOKEN: creds.SessionToken },
  });
  const ami = r.stdout.trim();
  if (r.code !== 0 || !/^ami-[0-9a-f]{8,17}$/.test(ami)) throw new DeployError(`could not resolve the AL2023 arm64 AMI: ${r.stderr}`);
  context[AMI_CONTEXT_KEY] = { ...pins, [region]: ami };
  await deps.writeText(CDK_CONTEXT_FILE, JSON.stringify(context, null, 2) + "\n");
  deps.log(`Pinned ${ami} for ${region} in deploy/aws/cdk.context.json (commit it).`);
  return ami;
}

// ---------------------------------------------------------------- stack helpers

/** The stack's outputs, or undefined if it does not exist. A stack left in
 * REVIEW_IN_PROGRESS by a first changeset that failed has no resources, so it
 * counts as not existing (cdk deploy creates it again). */
async function stackOutputs(ctx: Context): Promise<Record<string, string> | undefined> {
  const r = await ctx.aws("reading the stack", ["cloudformation", "describe-stacks", "--stack-name", stackName(ctx.stage)]).catch(() => "");
  if (!r) return undefined;
  const stack = (JSON.parse(r) as { Stacks: { StackStatus?: string; Outputs?: { OutputKey: string; OutputValue: string }[] }[] }).Stacks[0];
  if (!stack || stack.StackStatus === "REVIEW_IN_PROGRESS") return undefined;
  return Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

function cdkArgs(opts: CommonOptions, stage: Stage): string[] {
  return ["-c", `stage=${stage}`, "-c", `region=${opts.region}`, "--profile", opts.profile];
}

function requireOutput(outputs: Record<string, string>, key: string): string {
  const v = outputs[key];
  if (!v) throw new DeployError(`the stack has no ${key} output`);
  return v;
}

// ---------------------------------------------------------------- release

async function releaseVersion(file: string, deps: Deps): Promise<string> {
  const version = (await must(deps.run, "reading VERSION from the release", systemTar(), ["-xOf", file, "VERSION"])).trim();
  if (!VERSION.test(version)) throw new DeployError(`the release's VERSION file is not a version: ${JSON.stringify(version)}`);
  return version;
}

/** `--release-file`: a local build, signed here with the dev key (spike and eval stages only). */
async function uploadDevRelease(ctx: Context, file: string, outputs: Record<string, string>, deps: Deps): Promise<string> {
  const version = await releaseVersion(file, deps);
  const sha256 = await deps.sha256File(file);
  await must(deps.run, "signing the release with the dev key", "minisign", ["-S", "-s", deps.devKeyFile, "-m", file, "-x", `${file}.minisig`, "-t", `memory-anywhere ${version} sha256 ${sha256}`]);
  return publishRelease(ctx, file, version, sha256, outputs, deps);
}

/**
 * `--release <version>`: the CI-signed GitHub release. Its signature is checked here against the
 * committed release key before anything is uploaded; the instance checks it again (§7.3).
 */
async function uploadCiRelease(ctx: Context, version: string, outputs: Record<string, string>, deps: Deps): Promise<string> {
  if (!VERSION.test(version)) throw new DeployError(`--release takes a version such as 0.2.0, not ${JSON.stringify(version)}`);
  const pub = await deps.readText(RELEASE_PUB).catch(() => undefined);
  if (!pub) throw new DeployError(`${RELEASE_PUB} is missing: create the release key first (deployment-aws.md §7.4)`);
  return deps.withTempDir(async (dir) => {
    const file = join(dir, releaseAsset(version));
    await deps.download(releaseUrl(version, releaseAsset(version)), file);
    await deps.download(releaseUrl(version, `${releaseAsset(version)}.minisig`), `${file}.minisig`);
    await must(deps.run, "verifying the release signature with release.pub", "minisign", ["-V", "-q", "-p", RELEASE_PUB, "-m", file, "-x", `${file}.minisig`]);
    const inside = await releaseVersion(file, deps);
    if (inside !== version) throw new DeployError(`the release tagged ${version} says it is ${inside}`);
    return publishRelease(ctx, file, version, await deps.sha256File(file), outputs, deps);
  });
}

/** Uploads a signed tarball and its signature, then names it as the stage's desired release. */
async function publishRelease(ctx: Context, file: string, version: string, sha256: string, outputs: Record<string, string>, deps: Deps): Promise<string> {
  const bucket = requireOutput(outputs, "ReleasesBucket");
  await ctx.aws("uploading the release", ["s3", "cp", "--only-show-errors", file, `s3://${bucket}/releases/${version}.tar.gz`]);
  await ctx.aws("uploading the signature", ["s3", "cp", "--only-show-errors", `${file}.minisig`, `s3://${bucket}/releases/${version}.tar.gz.minisig`]);
  await ctx.aws("setting release/desired", [
    "ssm",
    "put-parameter",
    "--name",
    `${parameterPrefix(ctx.stage)}/release/desired`,
    "--type",
    "String",
    "--overwrite",
    "--value",
    JSON.stringify({ version, sha256 }),
  ]);
  deps.log(`Release ${version} (sha256 ${sha256}) uploaded and set as desired; the instance installs it within 2 minutes.`);
  return version;
}

// ---------------------------------------------------------------- DNS and health

/** §6.2: a CAA record that names only Let's Encrypt; missing or different is a warning, not a stop. */
async function checkCaa(ctx: Context, deps: Deps): Promise<void> {
  let records: string[];
  try {
    records = await resolveCaa(deps.fetch, ctx.host);
  } catch (e) {
    deps.log(`Warning: could not check the CAA record of ${ctx.host} (${(e as Error).message}).`);
    return;
  }
  if (!caaAllowsOnlyLetsEncrypt(records)) {
    deps.log(`Warning: ${ctx.host} has ${records.length === 0 ? "no CAA record" : `CAA ${records.join("; ")}`}. Add CAA 0 issue "letsencrypt.org", so no other CA may issue for it.`);
  }
}

/**
 * Whether a `cdk diff` replaces the EC2 instance: the resource is removed, marked for replacement,
 * or one of its changed properties requires (or may cause) replacement.
 */
export function replacesInstance(diff: string): boolean {
  let inInstance = false;
  for (const line of diff.split(/\r?\n/u)) {
    const resource = /^\[([-+~])\]\s+(\S+)/u.exec(line);
    if (resource) {
      inInstance = resource[2] === "AWS::EC2::Instance";
      if (inInstance && (resource[1] === "-" || /\breplace\b/iu.test(line))) return true;
      continue;
    }
    if (inInstance && /(requires|may cause) replacement/iu.test(line)) return true;
  }
  return false;
}

function printRecords(ctx: Context, elasticIp: string, deps: Deps, verb: "Add" | "Delete"): void {
  const names = stageHostnames(ctx.stage, ctx.host);
  deps.log("");
  deps.log(`${verb} these records in Cloudflare (zone of ${ctx.host}):`);
  for (const n of names) deps.log(`  A    ${n}  ->  ${elasticIp}   DNS only (grey cloud), TTL Auto`);
  if (verb === "Add") deps.log(`  CAA  ${ctx.host}  0 issue "letsencrypt.org"   (once; keep it when stacks are destroyed)`);
  deps.log("");
}

async function waitForDns(ctx: Context, elasticIp: string, deps: Deps): Promise<void> {
  const names = stageHostnames(ctx.stage, ctx.host);
  const deadline = deps.now() + DNS_TIMEOUT_MS;
  const last = new Map<string, string>();
  for (;;) {
    let ready = 0;
    for (const name of names) {
      const state = classifyName(await resolveA(deps.fetch, name), elasticIp);
      const line =
        state.kind === "ready"
          ? `${name}: resolves to ${elasticIp}`
          : state.kind === "missing"
            ? `${name}: no A record yet`
            : state.kind === "proxied"
              ? `${name}: resolves to Cloudflare (${state.ips.join(", ")}): the record is proxied; set it to DNS only (grey cloud)`
              : `${name}: resolves to ${state.ips.join(", ")}, not ${elasticIp}`;
      if (last.get(name) !== line) deps.log(line);
      last.set(name, line);
      if (state.kind === "ready") ready++;
    }
    if (ready === names.length) return;
    if (deps.now() > deadline) throw new DeployError("DNS did not resolve to the Elastic IP within 60 minutes");
    await deps.sleep(DNS_POLL_MS);
  }
}

async function waitForNoDns(ctx: Context, elasticIp: string, deps: Deps): Promise<void> {
  const names = stageHostnames(ctx.stage, ctx.host);
  for (;;) {
    const still: string[] = [];
    for (const name of names) if ((await resolveA(deps.fetch, name)).includes(elasticIp)) still.push(name);
    if (still.length === 0) return;
    deps.log(`Waiting: ${still.join(", ")} still resolve(s) to ${elasticIp} (checking every 30 s) ...`);
    await deps.sleep(DNS_POLL_MS);
  }
}

async function waitForHealth(ctx: Context, version: string, deps: Deps): Promise<void> {
  const url = `https://${stageHost(ctx.stage, ctx.host)}/v1/health`;
  const deadline = deps.now() + HEALTH_TIMEOUT_MS;
  deps.log(`Waiting for ${url} to report ${version} (up to 15 minutes; the first certificate takes a minute) ...`);
  for (;;) {
    try {
      const res = await deps.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok && ((await res.json()) as { version?: string }).version === version) {
        deps.log(`Healthy: ${version}.`);
        return;
      }
    } catch {
      // not up yet
    }
    if (deps.now() > deadline) throw new DeployError(`${url} did not report ${version} within 15 minutes`);
    await deps.sleep(15_000);
  }
}

// ---------------------------------------------------------------- empty buckets

/** S3 DeleteObjects accepts at most 1,000 keys per request. */
const DELETE_BATCH = 1000;

/** Deletes every object version and delete marker in a non-prod bucket. The key list goes
 * through a temporary file (`--delete file://…`): inline JSON for 1,000 keys overflows the
 * Windows command-line limit of 32,767 characters. */
/**
 * What a destroyed non-prod stack leaves behind, because CloudFormation never owned it (spec-issues
 * #21): the stage's SSM parameters, written at run time, and the DLM snapshots of its root volume.
 */
async function removeLeftovers(ctx: Context, deps: Deps): Promise<{ parameters: number; snapshots: number }> {
  if (ctx.stage === "prod") throw new DeployError("internal: prod's parameters and snapshots are never removed");
  const prefix = parameterPrefix(ctx.stage);
  const names = JSON.parse(
    (await ctx.aws("listing the stage's parameters", ["ssm", "get-parameters-by-path", "--path", prefix, "--recursive", "--query", "Parameters[].Name", "--output", "json"])) || "[]",
  ) as string[];
  for (let i = 0; i < names.length; i += 10) {
    await ctx.aws("deleting the stage's parameters", ["ssm", "delete-parameters", "--names", ...names.slice(i, i + 10)]);
  }
  const snapshots = JSON.parse(
    (await ctx.aws("listing the stage's snapshots", [
      "ec2", "describe-snapshots", "--owner-ids", "self", "--filters", `Name=tag:memory-anywhere:stage,Values=${ctx.stage}`, "--query", "Snapshots[].SnapshotId", "--output", "json",
    ])) || "[]",
  ) as string[];
  for (const id of snapshots) await ctx.aws(`deleting snapshot ${id}`, ["ec2", "delete-snapshot", "--snapshot-id", id]);
  deps.log(`removed ${names.length} parameter(s) under ${prefix} and ${snapshots.length} snapshot(s) of the stage's volume`);
  return { parameters: names.length, snapshots: snapshots.length };
}

async function emptyBucket(ctx: Context, bucket: string, deps: Deps): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await ctx.aws(`listing ${bucket}`, ["s3api", "list-object-versions", "--bucket", bucket, "--max-items", "1000"]).catch((e: Error) => {
      if (/NoSuchBucket/.test(e.message)) return "{}";
      throw e;
    });
    const body = JSON.parse(page || "{}") as { Versions?: { Key: string; VersionId: string }[]; DeleteMarkers?: { Key: string; VersionId: string }[] };
    const objects = [...(body.Versions ?? []), ...(body.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
    if (objects.length === 0) return deleted;
    for (let i = 0; i < objects.length; i += DELETE_BATCH) {
      const batch = objects.slice(i, i + DELETE_BATCH);
      await deps.withTempFile(JSON.stringify({ Objects: batch, Quiet: true }), (file) =>
        ctx.aws(`emptying ${bucket}`, ["s3api", "delete-objects", "--bucket", bucket, "--delete", `file://${file}`]),
      );
      deleted += batch.length;
    }
    deps.log(`  ${bucket}: deleted ${deleted} object versions`);
  }
}

// ---------------------------------------------------------------- commands

/** Runs body and then signs out of the SSO session, success or failure. It skips the
 * sign-out only when no session ever answered: a sign-in the owner completes while a
 * failed run is exiting must not be deleted by that run. */
async function withLogout<T>(opts: CommonOptions, deps: Deps, body: (session: Session) => Promise<T>): Promise<T> {
  const session: Session = { used: false };
  try {
    return await body(session);
  } finally {
    if (session.used && opts.stage !== "prod") {
      // Owner decision 2026-11-08 (spec-issues.md #11): non-prod stages keep the sign-in, which
      // ends with the Identity Center session or `aws sso logout`. Prod always signs out.
      deps.log("Keeping the deploy sign-in (non-prod stage). End it any time with: aws sso logout");
    } else if (session.used) {
      const r = await deps.run("aws", ["sso", "logout", "--profile", opts.profile]);
      deps.log(r.code === 0 ? "Signed out of the deploy SSO session." : `Warning: aws sso logout failed: ${r.stderr}`);
    } else {
      deps.log("Not signed in, so there was no deploy session to sign out of.");
    }
  }
}

export async function deployAws(opts: DeployOptions, deps: Deps): Promise<void> {
  return withLogout(opts, deps, async (session) => {
    const ctx = await begin(opts, deps, session);
    const nonProd = ctx.stage !== "prod";
    if (opts.dns !== "manual") throw new DeployError("only --dns manual is implemented (Route 53 is for other self-hosters)");
    if (opts.yes && !nonProd) throw new DeployError("--yes is only allowed for non-prod stages");
    if (opts.releaseFile && !nonProd) throw new DeployError("--release-file (dev-signed) is only allowed for spike and eval stages; prod takes CI-signed releases");
    if (opts.release && opts.releaseFile) throw new DeployError("give --release or --release-file, not both");
    if (opts.release && ctx.stage === "spike") throw new DeployError("the spike trusts only the dev key: use --release-file");
    const alertEmail = (opts.alertEmail ?? deps.env["MA_ALERT_EMAIL"] ?? "").trim();
    if (!EMAIL.test(alertEmail)) throw new DeployError("an alert email is required: --alert-email <address> or MA_ALERT_EMAIL");

    await checkBootstrap(ctx, opts.region);
    await pinnedAmi(ctx, opts.region, deps);
    const existing = await stackOutputs(ctx);
    if (existing && !opts.update) throw new DeployError(`${stackName(ctx.stage)} already exists: use --update`);
    if (!existing && opts.update) throw new DeployError(`${stackName(ctx.stage)} does not exist yet: run without --update first`);

    const cdk = (args: string[]) => must(deps.run, `cdk ${args[0]}`, process.execPath, [CDK_CLI, ...args], { cwd: DEPLOY_AWS_DIR, inherit: true });
    const params = ["--parameters", `Host=${ctx.host}`, "--parameters", `AlertEmail=${alertEmail}`];
    // The diff is captured, shown, and checked: replacing prod's instance rebuilds its disk from the
    // backup, so it needs --allow-replace.
    const diff = await deps.run(process.execPath, [CDK_CLI, "diff", stackName(ctx.stage), ...cdkArgs(opts, ctx.stage), ...params, "--no-color"], { cwd: DEPLOY_AWS_DIR });
    for (const line of `${diff.stdout}\n${diff.stderr}`.trim().split(/\r?\n/u)) deps.log(line);
    if (diff.code !== 0 && diff.code !== 1) throw new DeployError(`cdk diff failed (exit ${diff.code})`);
    if (!nonProd && existing && replacesInstance(`${diff.stdout}\n${diff.stderr}`) && !opts.allowReplace) {
      throw new DeployError("this change replaces prod's instance; nothing deployed. Rerun with --allow-replace only if that is intended (the store is restored from the backup, deployment-aws.md §5.5)");
    }
    if (!(opts.yes && nonProd) && !(await deps.confirm(`Deploy ${stackName(ctx.stage)} with the changes above?`))) {
      throw new DeployError("not confirmed; nothing deployed");
    }
    await cdk(["deploy", stackName(ctx.stage), ...cdkArgs(opts, ctx.stage), ...params, "--require-approval", "never"]);

    const outputs = await stackOutputs(ctx);
    if (!outputs) throw new DeployError("the stack deployed but its outputs could not be read");
    const elasticIp = requireOutput(outputs, "ElasticIp");
    const version = opts.releaseFile ? await uploadDevRelease(ctx, opts.releaseFile, outputs, deps)
      : opts.release ? await uploadCiRelease(ctx, opts.release, outputs, deps)
      : undefined;

    printRecords(ctx, elasticIp, deps, "Add");
    await checkCaa(ctx, deps);
    await waitForDns(ctx, elasticIp, deps);
    if (version) await waitForHealth(ctx, version, deps);

    deps.log("");
    deps.log("Next, in CloudShell as ma-operator (deployment-aws.md §3.2):");
    deps.log(`  ./ma-operator.sh setup-link --stage ${ctx.stage}`);
    deps.log(`  ./ma-operator.sh set-llm-key --stage ${ctx.stage}`);
    deps.log("Confirm the SNS subscription email AWS sent to the alert address.");
  });
}

export async function destroyAws(opts: CommonOptions, deps: Deps): Promise<void> {
  return withLogout(opts, deps, async (session) => {
    const ctx = await begin(opts, deps, session);
    const outputs = await stackOutputs(ctx);
    if (!outputs) throw new DeployError(`${stackName(ctx.stage)} does not exist in ${opts.region}`);
    const elasticIp = requireOutput(outputs, "ElasticIp");
    if (ctx.stage === "prod") {
      deps.log("prod: the backup, releases and trail buckets and the key are retained; delete-data is an operator step.");
    }
    if (!(await deps.confirm(`Destroy ${stackName(ctx.stage)} (instance, Elastic IP${ctx.stage === "prod" ? "" : ", buckets and their contents"})?`))) {
      throw new DeployError("not confirmed; nothing destroyed");
    }

    // A record pointing at a released IP could be taken over (§6.3): DNS goes first.
    printRecords(ctx, elasticIp, deps, "Delete");
    await waitForNoDns(ctx, elasticIp, deps);
    deps.log("No record resolves to the Elastic IP any more.");

    const buckets = ctx.stage === "prod" ? [] : ["BackupBucket", "ReleasesBucket", "TrailBucket"].map((k) => requireOutput(outputs, k));
    const cdk = () =>
      deps.run(process.execPath, [CDK_CLI, "destroy", stackName(ctx.stage), ...cdkArgs(opts, ctx.stage), "--force"], { cwd: DEPLOY_AWS_DIR, inherit: true });
    // CloudTrail can deliver one more log file between emptying and deletion, so retry.
    for (let attempt = 1; ; attempt++) {
      for (const b of buckets) await emptyBucket(ctx, b, deps);
      const r = await cdk();
      if (r.code === 0) break;
      if (attempt === 3) throw new DeployError("cdk destroy failed three times; see the output above");
      deps.log(`cdk destroy failed (attempt ${attempt}); emptying the buckets again and retrying ...`);
    }
    if (ctx.stage !== "prod") await removeLeftovers(ctx, deps);
    deps.log(`${stackName(ctx.stage)} destroyed; its Elastic IP is released${ctx.stage === "prod" ? "" : " and its key is scheduled for deletion (30 days)"}.`);
    deps.log(`Check in Cloudflare that the record(s) are gone: ${stageHostnames(ctx.stage, ctx.host).join(", ")}. Keep the CAA record on ${ctx.host}.`);
  });
}
