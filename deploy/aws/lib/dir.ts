// Where the CDK app lives on disk, for `mema deploy aws` (which runs the CDK CLI there).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_AWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CDK_CLI = join(DEPLOY_AWS_DIR, "node_modules", "aws-cdk", "bin", "cdk");
export const CDK_CONTEXT_FILE = join(DEPLOY_AWS_DIR, "cdk.context.json");
export const AMI_CONTEXT_KEY = "memory-anywhere:ami-al2023-arm64";
export const AMI_SSM_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
