// Every name the stack and the deploy commands share (deployment-aws.md §2).
// The IAM documents in ../iam/ match these patterns, so changing one here
// without changing the other breaks the bootstrap's guarantees.

export type Stage = "prod" | "spike" | `eval-${string}`;

const STAGE = /^(prod|spike|eval-[a-z0-9]{1,12})$/;

export function parseStage(value: string | undefined): Stage {
  if (!value || !STAGE.test(value)) {
    throw new Error(`stage must be prod, spike or eval-<id> (lowercase letters and digits, at most 12); got ${JSON.stringify(value)}`);
  }
  return value as Stage;
}

export const TAG_STAGE = "memory-anywhere:stage";
export const CDK_QUALIFIER = "hnb659fds";
export const BOUNDARY_POLICY = "memory-anywhere-boundary";

export function stackName(stage: Stage): string {
  return `MemoryAnywhere-${stage}`;
}

/** SSM prefix without a trailing slash: `/memory-anywhere` for prod. */
export function parameterPrefix(stage: Stage): string {
  return stage === "prod" ? "/memory-anywhere" : `/memory-anywhere-${stage}`;
}

/** Name of the public hostname the stage serves, relative to {host}. */
export function stageHost(stage: Stage, host: string): string {
  if (stage === "prod") return host;
  if (stage === "spike") return `spike.${host}`;
  return `eval.${host}`;
}

/** Hostnames that need DNS records for this stage (deployment-aws.md §6.2, §8, §9). */
export function stageHostnames(stage: Stage, host: string): string[] {
  if (stage === "spike") return [`spike.${host}`];
  const main = stageHost(stage, host);
  return [main, `admin.${main}`];
}

export type BucketKind = "backup" | "releases" | "trail";

export function bucketName(kind: BucketKind, account: string, region: string, stage: Stage): string {
  return `memory-anywhere-${kind}-${account}-${region}-${stage}`;
}

export const names = {
  instanceRole: (stage: Stage) => `memory-anywhere-instance-${stage}`,
  instanceProfile: (stage: Stage) => `memory-anywhere-instance-${stage}`,
  dlmRole: (stage: Stage) => `memory-anywhere-dlm-${stage}`,
  keyAlias: (stage: Stage) => `alias/memory-anywhere-${stage}`,
  alertsTopic: (stage: Stage) => `memory-anywhere-alerts-${stage}`,
  logGroup: (stage: Stage) => `/memory-anywhere/${stage}/server`,
  trail: (stage: Stage) => `memory-anywhere-${stage}`,
  budget: (stage: Stage) => `memory-anywhere-${stage}`,
  anomalyMonitor: (stage: Stage) => `memory-anywhere-${stage}`,
  alarm: (stage: Stage, what: string) => `memory-anywhere-${stage}-${what}`,
  rule: (stage: Stage, what: string) => `memory-anywhere-${stage}-${what}`,
  launchTemplate: (stage: Stage) => `memory-anywhere-${stage}`,
  cfnExecRole: (account: string, region: string) => `cdk-${CDK_QUALIFIER}-cfn-exec-role-${account}-${region}`,
};

/** Release signing keys the stage's instances trust (deployment-aws.md §7.4). */
export function trustedReleaseKeys(stage: Stage): string[] {
  if (stage === "prod") return ["release.pub"];
  if (stage === "spike") return ["dev.pub"];
  return ["release.pub", "dev.pub"];
}
