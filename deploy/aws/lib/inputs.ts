// Everything the stack reads from the repository: the stage's release keys,
// the binary pins and the host files that go into user data.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY_AWS_DIR } from "./dir.ts";
import { parseStage, trustedReleaseKeys, type Stage } from "./names.ts";
import type { HostFile, ReleaseKey } from "./user-data.ts";

export { DEPLOY_AWS_DIR };

const AMI = /^ami-[0-9a-f]{8,17}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface StackInputs {
  stage: Stage;
  region: string;
  amiId: string;
  releaseKeys: ReleaseKey[];
  pins: string;
  hostFiles: HostFile[];
}

export function loadStackInputs(ctx: { stage: string | undefined; region: string | undefined; amiPins: Record<string, string> | undefined }): StackInputs {
  const stage = parseStage(ctx.stage);
  const region = ctx.region ?? "";
  if (!REGION.test(region)) throw new Error(`context region must be an AWS region such as us-east-1; got ${JSON.stringify(ctx.region)}`);
  const amiId = ctx.amiPins?.[region] ?? "";
  if (!AMI.test(amiId)) {
    throw new Error(`no AL2023 arm64 AMI pinned for ${region} in cdk.context.json ("memory-anywhere:ami-al2023-arm64"); run mema deploy aws, which pins it`);
  }
  return { stage, region, amiId, releaseKeys: readReleaseKeys(stage), pins: readHost("pins.env"), hostFiles: hostFiles() };
}

function readHost(name: string): string {
  return readFileSync(join(DEPLOY_AWS_DIR, "host", name), "utf8");
}

/** The public keys a stage trusts, read from `dir` (deploy/aws/release-keys). */
export function readReleaseKeys(stage: Stage, dir = join(DEPLOY_AWS_DIR, "release-keys")): ReleaseKey[] {
  return trustedReleaseKeys(stage).map((name) => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`stage ${stage} trusts ${name}, but deploy/aws/release-keys/${name} does not exist`);
    const content = readFileSync(file, "utf8");
    if (!/^untrusted comment: .*\nRW[A-Za-z0-9+/]{54}\n?$/.test(content.replace(/\r\n/g, "\n"))) {
      throw new Error(`deploy/aws/release-keys/${name} is not a minisign public key`);
    }
    return { name, content: content.replace(/\r\n/g, "\n") };
  });
}

export function hostFiles(): HostFile[] {
  return [
    { path: "/usr/local/sbin/ma-firstboot", mode: "0755", content: readHost("firstboot.sh") },
    { path: "/usr/local/sbin/ma-updater", mode: "0755", content: readHost("ma-updater.sh") },
    { path: "/etc/systemd/system/ma-updater.service", mode: "0644", content: readHost("ma-updater.service") },
    { path: "/etc/systemd/system/ma-updater.timer", mode: "0644", content: readHost("ma-updater.timer") },
  ];
}
