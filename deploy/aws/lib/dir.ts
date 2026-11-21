// Where `mema deploy aws` finds the CDK app, its files and the CDK CLI (config-and-cli.md §1).
// The same code runs from a repository checkout and from the npm package `memory-anywhere`:
//
//   repository checkout                     npm package memory-anywhere
//   deploy/aws/          ◄── root           <package>/            ◄── root
//     lib/dir.ts   (this module)              bin/memory-anywhere.mjs  (the client bundle: this module inside)
//     bin/app.ts   (the CDK app)              deploy/app.mjs           (the CDK app, bundled)
//     host/, release-keys/, cdk.json          deploy/host/, deploy/release-keys/, deploy/cdk.json
//     cdk.context.json (committed)            {config}/cdk/cdk.json, cdk.context.json (written per user)
//
// In both, the parent of this module's folder is the root, and `deploy/app.mjs` marks the package.
// A checkout runs the CDK in deploy/aws, where the AMI pins are committed; an install has no
// repository, so it runs the CDK in a folder of the user's config.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED_APP = join(ROOT, "deploy", "app.mjs");

/** True when running from the npm package, false in a repository checkout. */
export const PACKAGED = existsSync(PACKAGED_APP);
/** The folder holding host/, release-keys/ and cdk.json. */
export const DEPLOY_AWS_DIR = PACKAGED ? join(ROOT, "deploy") : ROOT;
/**
 * The CDK CLI, resolved like any dependency (nested or hoisted by npm, pnpm's store in a checkout).
 * Resolved on use: the same bundle also runs inside the coding tools' plugins, which have no CDK.
 */
export const cdkCli = (): string => createRequire(import.meta.url).resolve("aws-cdk/bin/cdk");
export const AMI_CONTEXT_KEY = "memory-anywhere:ami-al2023-arm64";
export const AMI_SSM_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";

/** Where the CDK runs: its working folder, the AMI pins, and the cdk.json to write first (installs only). */
export interface CdkWorkspace {
	readonly dir: string;
	readonly contextFile: string;
	/** For an install, the cdk.json that points the CDK at the bundled app; a checkout commits its own. */
	readonly cdkJson?: string;
}

export function cdkWorkspace(configDir: string, node: string = process.execPath): CdkWorkspace {
	if (!PACKAGED) return { dir: DEPLOY_AWS_DIR, contextFile: join(DEPLOY_AWS_DIR, "cdk.context.json") };
	const dir = join(configDir, "cdk");
	return {
		dir,
		contextFile: join(dir, "cdk.context.json"),
		cdkJson: packagedCdkJson(packagedFlags(), node, PACKAGED_APP),
	};
}

/** The checkout's cdk.json with its `app` pointed at the bundled app; the feature flags stay the same. */
export function packagedCdkJson(flags: Record<string, unknown>, node: string, app: string): string {
	return `${JSON.stringify({ app: `"${node}" "${app}"`, output: "cdk.out", context: flags }, null, 2)}\n`;
}

function packagedFlags(): Record<string, unknown> {
	// The package ships the checkout's cdk.json; only its feature flags are reused.
	return (JSON.parse(readFileSync(join(DEPLOY_AWS_DIR, "cdk.json"), "utf8")) as { context: Record<string, unknown> })
		.context;
}
