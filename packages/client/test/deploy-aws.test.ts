import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { defaultFileDeps, deployAws, destroyAws, RELEASE_PUB, RELEASE_REPO, replacesInstance, type Deps, type DeployOptions } from "../src/deploy/aws.ts";
import { caaAllowsOnlyLetsEncrypt } from "../src/deploy/dns.ts";
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
/** A CloudTrail-style key: long enough that 1,000 of them inline overflow a Windows command line. */
const trailKey = (i: number) => `AWSLogs/${ACCOUNT}/CloudTrail/us-east-1/2026/11/10/${ACCOUNT}_CloudTrail_us-east-1_20261110T0005Z_${String(i).padStart(16, "0")}.json.gz`;

function world(
  opts: { arn?: string; bootstrap?: boolean; imdsHops?: number; stackExists?: boolean; dns?: string[][]; cdkFailures?: number; trailObjects?: number } = {},
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  /** Temporary files the code under test wrote, by path. */
  const tempFiles = new Map<string, string>();
  /** Object versions per bucket; the trail bucket starts with trailObjects versions and as many delete markers. */
  const buckets = new Map<string, { Key: string; VersionId: string }[]>([
    ["b-trail", Array.from({ length: (opts.trailObjects ?? 0) * 2 }, (_, i) => ({ Key: trailKey(i >> 1), VersionId: `v${i}`.padEnd(32, "x") }))],
  ]);
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
    (a) => (has(a, "describe-stacks") && a.some((x) => x.startsWith("MemoryAnywhere-")) ? (stackExists ? ok(JSON.stringify(outputs)) : fail("does not exist")) : undefined),
    (a) => {
      if (!has(a, "list-object-versions")) return undefined;
      // Like the CLI with --max-items 1000: up to 1,000 versions plus up to 1,000 delete markers.
      const all = buckets.get(a[a.indexOf("--bucket") + 1] ?? "") ?? [];
      const versions = all.filter((_, i) => i % 2 === 0).slice(0, 1000);
      const markers = all.filter((_, i) => i % 2 === 1).slice(0, 1000);
      return ok(all.length ? JSON.stringify({ Versions: versions, DeleteMarkers: markers }) : "{}");
    },
    (a) => {
      if (!has(a, "delete-objects")) return undefined;
      const ref = a[a.indexOf("--delete") + 1] ?? "";
      const payload = tempFiles.get(ref.slice("file://".length));
      if (!payload) return fail(`expected --delete file://<temp file>, got ${ref.slice(0, 40)}`);
      const doomed = JSON.parse(payload) as { Objects: { VersionId: string }[] };
      if (doomed.Objects.length > 1000) return fail("MalformedXML: more than 1000 keys");
      const bucket = a[a.indexOf("--bucket") + 1] ?? "";
      const gone = new Set(doomed.Objects.map((o) => o.VersionId));
      buckets.set(bucket, (buckets.get(bucket) ?? []).filter((o) => !gone.has(o.VersionId)));
      return ok();
    },
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
      // The instance reports release 0.2.0, the one the release tests deploy.
      if (url.endsWith("/v1/health")) return { ok: true, status: 200, json: async () => ({ ok: true, version: "0.2.0" }) };
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
    withTempFile: async (text, use) => {
      const path = `C:/fake tmp/mema-${tempFiles.size}/payload.json`;
      tempFiles.set(path, text);
      return use(path);
    },
    withTempDir: async (use) => use("C:/fake tmp/mema-release"),
    download: async (url, file) => {
      calls.push({ command: "download", args: [url, file] });
    },
  };
  return { deps, calls, logs, buckets };
}

const spikeOpts: DeployOptions = { stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy", update: false, yes: true, dns: "manual" };

const cdkCalls = (calls: Call[]) => calls.filter((c) => c.command === process.execPath).map((c) => c.args[1]);
const lastCall = (calls: Call[]) => calls.at(-1);

describe("mema deploy aws: refusals", () => {
  it("refuses without MA_DOMAIN before touching AWS, and has no session to sign out of", async () => {
    const w = world();
    w.deps.env = {};
    await expect(deployAws(spikeOpts, w.deps)).rejects.toThrow(/MA_DOMAIN is not set/);
    expect(w.calls).toEqual([]);
  });

  it("does not sign out when the sign-in check fails (a sign-in may be completing meanwhile)", async () => {
    const w = world();
    const run = w.deps.run;
    w.deps.run = async (command, args, o) =>
      has(args, "get-caller-identity") ? (w.calls.push({ command, args }), fail("Error loading SSO Token")) : run(command, args, o);
    await expect(deployAws(spikeOpts, w.deps)).rejects.toThrow(/checking the SSO sign-in/);
    expect(w.calls.some((c) => has(c.args, "sso", "logout"))).toBe(false);
  });

  it("refuses a sign-in that is not the deploy permission set", async () => {
    const w = world({ arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_memory-anywhere-operator_0123456789abcdef/ma-operator` });
    await expect(deployAws(spikeOpts, w.deps)).rejects.toThrow(/not signed in with the memory-anywhere-deploy permission set/);
  });

  it("always signs out after prod, even when it refuses", async () => {
    const w = world();
    await expect(deployAws({ ...spikeOpts, stage: "prod" }, w.deps)).rejects.toThrow(/--yes is only allowed/);
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

  it("treats a stack left in REVIEW_IN_PROGRESS by a failed first changeset as absent", async () => {
    const w = world();
    const run = w.deps.run;
    w.deps.run = async (command, args, o) =>
      has(args, "describe-stacks", "MemoryAnywhere-spike") && !w.calls.some((c) => c.command === process.execPath && c.args.includes("deploy"))
        ? (w.calls.push({ command, args }), ok(JSON.stringify({ Stacks: [{ StackStatus: "REVIEW_IN_PROGRESS" }] })))
        : run(command, args, o);
    await deployAws(spikeOpts, w.deps);
    expect(cdkCalls(w.calls)).toEqual(["diff", "deploy"]);
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

describe("instance replacement guard", () => {
  it("reads a cdk diff: removal, replacement, or a property that requires or may cause it", () => {
    expect(replacesInstance("Resources\n[~] AWS::EC2::Instance Instance InstanceC1063A87 replace\n")).toBe(true);
    expect(replacesInstance("[~] AWS::EC2::Instance Instance InstanceC1063A87\n └─ [~] ImageId (requires replacement)\n")).toBe(true);
    expect(replacesInstance("[~] AWS::EC2::Instance Instance X\n └─ [~] UserData (may cause replacement)\n")).toBe(true);
    expect(replacesInstance("[-] AWS::EC2::Instance Instance X destroy\n")).toBe(true);
    expect(replacesInstance("[~] AWS::EC2::Instance Instance X\n └─ [~] Tags\n[~] AWS::S3::Bucket B\n └─ [~] Name (requires replacement)\n")).toBe(false);
    expect(replacesInstance("There were no differences\n")).toBe(false);
  });

  it("stops a prod update that replaces the instance, unless --allow-replace", async () => {
    const replacing = (w: ReturnType<typeof world>) => {
      const run = w.deps.run;
      w.deps.run = async (command, args, o) =>
        command === process.execPath && args.includes("diff") ? (w.calls.push({ command, args }), ok("[~] AWS::EC2::Instance Instance I replace\n")) : run(command, args, o);
      return w;
    };
    const prodUpdate = { ...spikeOpts, stage: "prod", update: true, yes: false };
    const stopped = replacing(world({ stackExists: true, dns: [[EIP, EIP]] }));
    await expect(deployAws(prodUpdate, stopped.deps)).rejects.toThrow(/replaces prod's instance/);
    expect(cdkCalls(stopped.calls)).toEqual(["diff"]);
    const allowed = replacing(world({ stackExists: true, dns: [[EIP]] }));
    await deployAws({ ...prodUpdate, allowReplace: true }, allowed.deps);
    expect(cdkCalls(allowed.calls)).toEqual(["diff", "deploy"]);
  });
});

describe("mema deploy aws --release (CI-signed)", () => {
  it("downloads the GitHub release, verifies it with release.pub, then uploads it and sets it desired", async () => {
    const w = world({ dns: [[EIP]] });
    const run = w.deps.run;
    w.deps.run = async (command, args, o) => (args.includes("-xOf") ? (w.calls.push({ command, args }), ok("0.2.0\n")) : run(command, args, o));
    await deployAws({ ...spikeOpts, stage: "eval-a1", release: "0.2.0" }, w.deps);
    const downloads = w.calls.filter((c) => c.command === "download").map((c) => c.args[0]);
    expect(downloads).toEqual([
      `https://github.com/${RELEASE_REPO}/releases/download/v0.2.0/memory-anywhere-server-0.2.0.tar.gz`,
      `https://github.com/${RELEASE_REPO}/releases/download/v0.2.0/memory-anywhere-server-0.2.0.tar.gz.minisig`,
    ]);
    const verify = w.calls.find((c) => c.command === "minisign");
    expect(verify?.args.slice(0, 4)).toEqual(["-V", "-q", "-p", RELEASE_PUB]);
    expect(w.calls.some((c) => c.command === "minisign" && c.args.includes("-S"))).toBe(false); // never re-signed with the dev key
    const order = w.calls.map((c) => (c.command === "minisign" ? "verify" : c.args.includes("cp") ? "upload" : ""));
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("upload"));
    expect(w.calls.find((c) => has(c.args, "put-parameter"))?.args.join(" ")).toContain('{"version":"0.2.0"');
  });

  it("refuses a tarball whose VERSION differs from the tag, and the spike, which trusts only the dev key", async () => {
    const w = world({ dns: [[EIP]] });
    const run = w.deps.run;
    w.deps.run = async (command, args, o) => (args.includes("-xOf") ? ok("0.1.9\n") : run(command, args, o));
    await expect(deployAws({ ...spikeOpts, stage: "eval-a1", release: "0.2.0" }, w.deps)).rejects.toThrow(/tagged 0\.2\.0 says it is 0\.1\.9/);
    await expect(deployAws({ ...spikeOpts, release: "0.2.0" }, world().deps)).rejects.toThrow(/trusts only the dev key/);
  });

  it("warns when the CAA record is missing or allows another CA", async () => {
    const w = world({ dns: [[EIP]] });
    await deployAws(spikeOpts, w.deps);
    expect(w.logs.join("\n")).toMatch(/has no CAA record/);
    expect(caaAllowsOnlyLetsEncrypt(['0 issue "letsencrypt.org"'])).toBe(true);
    expect(caaAllowsOnlyLetsEncrypt(['0 issue "letsencrypt.org"', '0 issue "sectigo.com"'])).toBe(false);
    expect(caaAllowsOnlyLetsEncrypt(["0 iodef \"mailto:x@example.com\""])).toBe(false);
  });
});

describe("mema deploy aws: the deploy", () => {
  it("passes the host only as a CloudFormation parameter, waits for DNS, and keeps the non-prod sign-in", async () => {
    const w = world({ dns: [[], ["104.16.1.1"], [EIP]] });
    await deployAws(spikeOpts, w.deps);
    const deploy = w.calls.find((c) => c.command === process.execPath && c.args.includes("deploy"));
    expect(deploy?.args).toEqual(expect.arrayContaining(["-c", "stage=spike", "--parameters", `Host=${HOST}`, "--require-approval", "never"]));
    expect(w.logs.join("\n")).toMatch(/A {4}spike\.memory\.example\.com {2}-> {2}198\.51\.100\.7 {3}DNS only/);
    expect(w.logs.join("\n")).toMatch(/proxied; set it to DNS only/);
    expect(w.logs.join("\n")).toMatch(/spike\.memory\.example\.com: resolves to 198\.51\.100\.7/);
    expect(w.calls.some((c) => has(c.args, "sso", "logout"))).toBe(false);
    expect(w.logs.join("\n")).toMatch(/Keeping the deploy sign-in \(non-prod stage\)/);
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
  });

  it("empties the buckets again and retries when cdk destroy fails", async () => {
    const w = world({ stackExists: true, dns: [[]], cdkFailures: 1 });
    await destroyAws({ stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    expect(cdkCalls(w.calls)).toEqual(["destroy", "destroy"]);
    expect(w.calls.filter((c) => has(c.args, "list-object-versions"))).toHaveLength(6);
  });

  it("empties a large bucket in batches of at most 1,000 keys, each passed through a temporary file", async () => {
    const w = world({ stackExists: true, dns: [[]], trailObjects: 1700 });
    await destroyAws({ stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    expect(w.buckets.get("b-trail")).toEqual([]);
    const deletes = w.calls.filter((c) => has(c.args, "delete-objects"));
    // 3,400 entries: two listing pages of 2,000 and 1,400, each split into batches of at most 1,000.
    expect(deletes).toHaveLength(4);
    // Windows limits a whole command line to 32,767 characters; every argument stays far below that.
    for (const c of deletes) expect(Math.max(...c.args.map((x) => x.length))).toBeLessThan(200);
    expect(w.logs).toContain("  b-trail: deleted 3400 object versions");
  });

  it("then removes the stage's parameters (10 per call) and its volume snapshots (spec-issues #21)", async () => {
    const w = world({ stackExists: true, dns: [[]] });
    const run = w.deps.run;
    const names = Array.from({ length: 12 }, (_, i) => `/memory-anywhere-spike/p${i}`);
    w.deps.run = (async (command: string, args: string[]) => {
      if (has(args, "get-parameters-by-path")) return (w.calls.push({ command, args }), ok(JSON.stringify(names)));
      if (has(args, "describe-snapshots")) return (w.calls.push({ command, args }), ok(JSON.stringify(["snap-1", "snap-2"])));
      return run(command, args);
    }) as Deps["run"];
    await destroyAws({ stage: "spike", region: "us-east-1", profile: "memory-anywhere-deploy" }, w.deps);
    const listing = w.calls.find((c) => has(c.args, "get-parameters-by-path"));
    expect(listing?.args[listing.args.indexOf("--path") + 1]).toBe("/memory-anywhere-spike");
    expect(w.calls.filter((c) => has(c.args, "delete-parameters")).map((c) => c.args.filter((a) => a.startsWith("/memory-anywhere-spike/")).length)).toEqual([10, 2]);
    expect(w.calls.find((c) => has(c.args, "describe-snapshots"))?.args).toContain("Name=tag:memory-anywhere:stage,Values=spike");
    expect(w.calls.filter((c) => has(c.args, "delete-snapshot")).map((c) => c.args[c.args.indexOf("--snapshot-id") + 1])).toEqual(["snap-1", "snap-2"]);
    const order = w.calls.map((c) => (c.command === process.execPath ? "cdk" : c.args.find((a) => /^(get-parameters-by-path|delete-snapshot)$/.test(a)) ?? ""));
    expect(order.indexOf("get-parameters-by-path")).toBeGreaterThan(order.lastIndexOf("cdk"));
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
    expect(w.calls.some((c) => has(c.args, "get-parameters-by-path") || has(c.args, "describe-snapshots"))).toBe(false);
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

describe("systemTar", () => {
  it("uses Windows' own tar.exe on Windows and tar elsewhere", async () => {
    const { systemTar } = await import("../src/deploy/process.ts");
    expect(systemTar("win32", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
    expect(systemTar("linux", {})).toBe("tar");
  });
});

describe("defaultFileDeps.withTempFile", () => {
  it("gives the callback a readable file with the text, then removes it", async () => {
    let seen = "";
    const result = await defaultFileDeps.withTempFile('{"Objects":[]}', async (path) => {
      seen = path;
      expect(readFileSync(path, "utf8")).toBe('{"Objects":[]}');
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  it("removes the file when the callback throws", async () => {
    let seen = "";
    await expect(
      defaultFileDeps.withTempFile("x", async (path) => {
        seen = path;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });
});
