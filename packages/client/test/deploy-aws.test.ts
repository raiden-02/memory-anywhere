import { describe, expect, it } from "vitest";
import { deployAws, destroyAws, type Deps, type DeployOptions } from "../src/deploy/aws.ts";
import { classifyName, isCloudflareIp } from "../src/deploy/dns.ts";
import type { RunResult } from "../src/deploy/process.ts";

const ACCOUNT = "111111111111";
const HOST = "memory.example.com";
const EIP = "198.51.100.7";
const DEPLOY_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_memory-anywhere-deploy_0123456789abcdef/ma-deploy`;

interface Call {
  command: string;
  args: string[];
}

type Responder = (args: string[]) => RunResult | undefined;
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 254, stdout: "", stderr });

function has(args: string[], ...words: string[]) {
  return words.every((w) => args.includes(w));
}

/** A fake AWS account and DNS, answering in the order the commands call them. */
function world(opts: { arn?: string; bootstrap?: boolean; imdsHops?: number; stackExists?: boolean; dns?: string[][]; cdkFailures?: number } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let stackExists = opts.stackExists ?? false;
  let cdkFailures = opts.cdkFailures ?? 0;
  const dnsAnswers = [...(opts.dns ?? [[EIP]])];
  const outputs = {
    Stacks: [
      {
        Outputs: [
          { OutputKey: "ElasticIp", OutputValue: EIP },
          { OutputKey: "BackupBucket", OutputValue: "b-backup" },
          { OutputKey: "ReleasesBucket", OutputValue: "b-releases" },
          { OutputKey: "TrailBucket", OutputValue: "b-trail" },
        ],
      },
    ],
  };
  const responders: Responder[] = [
    (a) => (has(a, "sts", "get-caller-identity") ? ok(JSON.stringify({ Account: ACCOUNT, Arn: opts.arn ?? DEPLOY_ARN })) : undefined),
    (a) =>
      has(a, "describe-stacks", "CDKToolkit")
        ? opts.bootstrap === false
          ? fail("Stack with id CDKToolkit does not exist")
          : ok(
              JSON.stringify({
                Stacks: [
                  {
                    Parameters: [
                      { ParameterKey: "Qualifier", ParameterValue: "hnb659fds" },
                      {
                        ParameterKey: "CloudFormationExecutionPolicies",
                        ParameterValue: `arn:aws:iam::${ACCOUNT}:policy/memory-anywhere-cfn-exec,arn:aws:iam::${ACCOUNT}:policy/memory-anywhere-cfn-exec-services`,
                      },
                    ],
                  },
                ],
              }),
            )
        : undefined,
    (a) => (has(a, "get-instance-metadata-defaults") ? ok(JSON.stringify({ AccountLevel: { HttpTokens: "required", HttpPutResponseHopLimit: opts.imdsHops ?? 1 } })) : undefined),
    (a) => (has(a, "describe-stacks", "MemoryAnywhere-spike") || has(a, "describe-stacks", "MemoryAnywhere-prod") ? (stackExists ? ok(JSON.stringify(outputs)) : fail("does not exist")) : undefined),
    (a) => (has(a, "list-object-versions") ? ok("{}") : undefined),
    (a) => (has(a, "sso", "logout") ? ok() : undefined),
  ];
  const deps: Deps = {
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === process.execPath) {
        if (args.includes("deploy")) stackExists = true;
        if (args.includes("destroy")) {
          if (cdkFailures-- > 0) return fail("bucket not empty");
          stackExists = false;
        }
        return ok();
      }
      for (const r of responders) {
        const res = r(args);
        if (res) return res;
      }
      return ok();
    },
    fetch: async (url) => {
      const name = new URL(url).searchParams.get("name") ?? "";
      calls.push({ command: "doh", args: [name] });
      const ips = dnsAnswers.length > 1 ? (dnsAnswers.shift() ?? []) : (dnsAnswers[0] ?? []);
      return { ok: true, status: 200, json: async () => ({ Status: ips.length ? 0 : 3, Answer: ips.map((data) => ({ type: 1, data })) }) };
    },
    sleep: async () => {},
    now: () => 0,
    log: (l) => logs.push(l),
    confirm: async () => true,
    env: { MA_DOMAIN: HOST, MA_ALERT_EMAIL: "owner@example.com" },
    devKeyFile: "C:/fake/dev-release.key",
    readText: async () => JSON.stringify({ "memory-anywhere:ami-al2023-arm64": { "us-east-1": "ami-0123456789abcdef0" } }),
    writeText: async () => {},
    sha256File: async () => "0".repeat(64),
  };
  return { deps, calls, logs };
}

const spikeOpts: DeployOptions = { stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy", update: false, yes: true, dns: "manual" };

const cdkCalls = (calls: Call[]) => calls.filter((c) => c.command === process.execPath).map((c) => c.args[1]);
const lastCall = (calls: Call[]) => calls.at(-1);

describe("mema deploy aws: refusals", () => {
  it("refuses without MA_DOMAIN and still signs out", async () => {
    const w = world();
    w.deps.env = {};
    await expect(deployAws(spikeOpts, w.deps)).rejects.toThrow(/MA_DOMAIN is not set/);
    expect(w.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["sso logout"]);
  });

  it("refuses a sign-in that is not the deploy permission set", async () => {
    const w = world({ arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_memory-anywhere-operator_0123456789abcdef/ma-operator` });
    await expect(deployAws(spikeOpts, w.deps)).rejects.toThrow(/not signed in with the memory-anywhere-deploy permission set/);
    expect(lastCall(w.calls)?.args.slice(0, 2)).toEqual(["sso", "logout"]);
  });

  it("refuses when the bootstrap or the IMDS default is missing", async () => {
    await expect(deployAws(spikeOpts, world({ bootstrap: false }).deps)).rejects.toThrow(/run the one-time bootstrap/);
    await expect(deployAws(spikeOpts, world({ imdsHops: 2 }).deps)).rejects.toThrow(/account IMDS default is not IMDSv2 with hop limit 1/);
  });

  it("refuses --yes and --release-file on prod", async () => {
    await expect(deployAws({ ...spikeOpts, stage: "prod" }, world().deps)).rejects.toThrow(/--yes is only allowed for non-prod/);
    await expect(deployAws({ ...spikeOpts, stage: "prod", yes: false, releaseFile: "r.tgz" }, world().deps)).rejects.toThrow(/only allowed for spike and eval/);
  });

  it("refuses to create a stack that exists, or update one that does not", async () => {
    await expect(deployAws(spikeOpts, world({ stackExists: true }).deps)).rejects.toThrow(/already exists: use --update/);
    await expect(deployAws({ ...spikeOpts, update: true }, world().deps)).rejects.toThrow(/does not exist yet/);
  });

  it("deploys nothing when the owner declines the diff", async () => {
    const w = world();
    w.deps.confirm = async () => false;
    await expect(deployAws({ ...spikeOpts, yes: false }, w.deps)).rejects.toThrow(/not confirmed/);
    expect(cdkCalls(w.calls)).toEqual(["diff"]);
  });
});

describe("mema deploy aws: the deploy", () => {
  it("passes the host only as a CloudFormation parameter, waits for DNS, and signs out", async () => {
    const w = world({ dns: [[], ["104.16.1.1"], [EIP]] });
    await deployAws(spikeOpts, w.deps);
    const deploy = w.calls.find((c) => c.command === process.execPath && c.args.includes("deploy"));
    expect(deploy?.args).toEqual(expect.arrayContaining(["-c", "stage=spike", "--parameters", `Host=${HOST}`, "--require-approval", "never"]));
    expect(w.logs.join("\n")).toMatch(/A {4}spike\.memory\.example\.com {2}-> {2}198\.51\.100\.7 {3}DNS only/);
    expect(w.logs.join("\n")).toMatch(/proxied; set it to DNS only/);
    expect(w.logs.join("\n")).toMatch(/spike\.memory\.example\.com: resolves to 198\.51\.100\.7/);
    expect(lastCall(w.calls)?.args.slice(0, 2)).toEqual(["sso", "logout"]);
  });
});

describe("mema destroy aws", () => {
  it("waits until DNS no longer points at the Elastic IP before destroying", async () => {
    const w = world({ stackExists: true, dns: [[EIP], [EIP], []] });
    await destroyAws({ stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    const order = w.calls.map((c) => (c.command === "doh" ? "doh" : c.command === process.execPath ? `cdk ${c.args[1]}` : c.args.slice(0, 2).join(" ")));
    const lastDoh = order.lastIndexOf("doh");
    expect(order.indexOf("cdk destroy")).toBeGreaterThan(lastDoh);
    expect(order.filter((o) => o === "doh")).toHaveLength(3);
    expect(w.calls.filter((c) => has(c.args, "list-object-versions")).map((c) => c.args[c.args.indexOf("--bucket") + 1])).toEqual(["b-backup", "b-releases", "b-trail"]);
    expect(lastCall(w.calls)?.args.slice(0, 2)).toEqual(["sso", "logout"]);
  });

  it("empties the buckets again and retries when cdk destroy fails", async () => {
    const w = world({ stackExists: true, dns: [[]], cdkFailures: 1 });
    await destroyAws({ stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    expect(cdkCalls(w.calls)).toEqual(["destroy", "destroy"]);
    expect(w.calls.filter((c) => has(c.args, "list-object-versions"))).toHaveLength(6);
  });

  it("does not empty prod buckets", async () => {
    const w = world({ stackExists: true, dns: [[]] });
    w.calls.length = 0;
    w.deps.run = (async (command: string, args: string[]) => {
      w.calls.push({ command, args });
      if (has(args, "get-caller-identity")) return ok(JSON.stringify({ Account: ACCOUNT, Arn: DEPLOY_ARN }));
      if (has(args, "describe-stacks")) return ok(JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "ElasticIp", OutputValue: EIP }] }] }));
      return ok();
    }) as Deps["run"];
    await destroyAws({ stage: "prod", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    expect(w.calls.some((c) => has(c.args, "list-object-versions"))).toBe(false);
  });
});

describe("DNS classification", () => {
  it("recognises Cloudflare proxy addresses", () => {
    expect(isCloudflareIp("104.16.1.1")).toBe(true);
    expect(isCloudflareIp("172.67.5.5")).toBe(true);
    expect(isCloudflareIp(EIP)).toBe(false);
    expect(isCloudflareIp("not-an-ip")).toBe(false);
  });

  it("is ready only for exactly the Elastic IP", () => {
    expect(classifyName([EIP], EIP)).toEqual({ kind: "ready" });
    expect(classifyName([], EIP)).toEqual({ kind: "missing" });
    expect(classifyName(["104.16.1.1"], EIP).kind).toBe("proxied");
    expect(classifyName([EIP, "203.0.113.9"], EIP).kind).toBe("wrong");
  });
});
