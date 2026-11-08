// CDK entry point: `cdk deploy -c stage=<stage> -c region=<region> --parameters Host=... --parameters AlertEmail=...`
// mema deploy aws builds this command line; nothing owner-specific is read here.

import { App } from "aws-cdk-lib";
import { AMI_CONTEXT_KEY } from "../lib/dir.ts";
import { loadStackInputs } from "../lib/inputs.ts";
import { MemoryAnywhereStack } from "../lib/stack.ts";

const app = new App();
// cdk.context.json gives an object; `-c key=value` on the command line gives a JSON string.
const rawPins: unknown = app.node.tryGetContext(AMI_CONTEXT_KEY);
const amiPins = (typeof rawPins === "string" ? JSON.parse(rawPins) : rawPins) as Record<string, string> | undefined;
const inputs = loadStackInputs({
  stage: app.node.tryGetContext("stage") as string | undefined,
  region: app.node.tryGetContext("region") as string | undefined,
  amiPins,
});
new MemoryAnywhereStack(app, { ...inputs, env: { region: inputs.region } });
