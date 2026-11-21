// Everything the stack reads from files: the stage's release keys (the committed release key and the
// user's own dev key), the binary pins and the host files that go into user data.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY_AWS_DIR } from "./dir.ts";
import { parseStage, type Stage } from "./names.ts";
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
	/**
	 * Raised by `mema deploy aws --replace-instance`: a new value changes the launch template, so
	 * CloudFormation builds a new instance, which restores the store from the backup (§5.5). 0 leaves
	 * the template as it was before the option existed.
	 */
	instanceGeneration: number;
}

export function loadStackInputs(ctx: {
	stage: string | undefined;
	region: string | undefined;
	amiPins: Record<string, string> | undefined;
	instanceGeneration?: string | undefined;
	/** The user's dev public key ({data}/dev-release.pub), passed as context `devReleaseKey`. */
	devKeyFile?: string | undefined;
}): StackInputs {
	const stage = parseStage(ctx.stage);
	const generation = String(ctx.instanceGeneration ?? "0");
	if (!/^(0|[1-9]\d{0,5})$/u.test(generation))
		throw new Error(`context instanceGeneration must be a whole number; got ${JSON.stringify(generation)}`);
	const region = ctx.region ?? "";
	if (!REGION.test(region))
		throw new Error(`context region must be an AWS region such as us-east-1; got ${JSON.stringify(ctx.region)}`);
	const amiId = ctx.amiPins?.[region] ?? "";
	if (!AMI.test(amiId)) {
		throw new Error(
			`no AL2023 arm64 AMI pinned for ${region} in cdk.context.json ("memory-anywhere:ami-al2023-arm64"); run mema deploy aws, which pins it`,
		);
	}
	return {
		stage,
		region,
		amiId,
		releaseKeys: readReleaseKeys(stage, { devKeyFile: ctx.devKeyFile }),
		pins: readHost("pins.env"),
		hostFiles: hostFiles(),
		instanceGeneration: Number(generation),
	};
}

function readHost(name: string): string {
	return readFileSync(join(DEPLOY_AWS_DIR, "host", name), "utf8");
}

/** Where a stage's trusted keys come from. */
export interface KeySources {
	/** The committed keys (deploy/aws/release-keys), holding release.pub, which CI releases are signed for. */
	readonly dir?: string;
	/** The public half of the user's own dev key, if they made one. */
	readonly devKeyFile?: string | undefined;
}

/**
 * The public keys a stage's instances trust (deployment-aws.md §7.4): prod only the release key; spike
 * only the user's dev key; an eval stage the release key, plus the dev key when the user has one. The
 * dev key is each user's own, so no one else can sign a build that their stages run.
 */
export function readReleaseKeys(stage: Stage, sources: KeySources = {}): ReleaseKey[] {
	const dir = sources.dir ?? join(DEPLOY_AWS_DIR, "release-keys");
	const release = (): ReleaseKey => {
		const file = join(dir, "release.pub");
		if (!existsSync(file))
			throw new Error(`stage ${stage} trusts release.pub, but deploy/aws/release-keys/release.pub does not exist`);
		return releaseKey("release.pub", file);
	};
	const dev = sources.devKeyFile !== undefined && existsSync(sources.devKeyFile) ? sources.devKeyFile : undefined;
	if (stage === "prod") return [release()];
	if (stage === "spike") {
		if (!dev)
			throw new Error(
				sources.devKeyFile
					? `the spike stage runs only builds signed with your dev key, but ${sources.devKeyFile} does not exist; create the pair with: minisign -G -W -p "${sources.devKeyFile}" -s "<the same folder>/dev-release.key"`
					: "the spike stage runs only builds signed with your dev key: pass its public key file as context devReleaseKey (mema deploy aws does)",
			);
		return [releaseKey("dev.pub", dev)];
	}
	return dev ? [release(), releaseKey("dev.pub", dev)] : [release()];
}

function releaseKey(name: string, file: string): ReleaseKey {
	const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	if (!/^untrusted comment: .*\nRW[A-Za-z0-9+/]{54}\n?$/.test(content))
		throw new Error(`${file} is not a minisign public key`);
	return { name, content };
}

export function hostFiles(): HostFile[] {
	return [
		{ path: "/usr/local/sbin/ma-firstboot", mode: "0755", content: readHost("firstboot.sh") },
		{ path: "/usr/local/sbin/ma-updater", mode: "0755", content: readHost("ma-updater.sh") },
		{ path: "/etc/systemd/system/ma-updater.service", mode: "0644", content: readHost("ma-updater.service") },
		{ path: "/etc/systemd/system/ma-updater.timer", mode: "0644", content: readHost("ma-updater.timer") },
	];
}
