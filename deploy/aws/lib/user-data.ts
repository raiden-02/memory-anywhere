// First-boot user data (deployment-aws.md §4, §7.3).
//
// User data carries only the trust anchor: the stack's settings, the pinned
// binary hashes, the release public keys, the first-boot script and the
// updater. Everything else (Node, Caddy, Litestream, units, the server) comes
// from a signed release that the updater verifies before running anything in
// it. That keeps user data under EC2's 16 KB limit and means a release can
// never replace the code that checks its own signature.
//
// Files are written with quoted heredocs and joined with Fn::Join, not Fn::Sub,
// so shell `${...}` in the scripts is never touched by CloudFormation. The
// static files travel gzipped and base64-encoded (about a third of their size):
// the updater alone is over 10 KB. stack.env stays plain text because its
// values are CloudFormation tokens, resolved only at deploy time.

import { gzipSync } from "node:zlib";
import { Fn } from "aws-cdk-lib";
import type { Stage } from "./names.ts";

export interface ReleaseKey {
	/** File name under /etc/memory-anywhere/release-keys/, e.g. dev.pub */
	name: string;
	content: string;
}

export interface HostFile {
	path: string;
	mode: string;
	content: string;
}

export interface UserDataInput {
	stage: Stage;
	prefix: string;
	region: string;
	host: string;
	alertEmail: string;
	/** IANA time zone (the OwnerTimezone parameter). */
	ownerTimezone: string;
	releasesBucket: string;
	backupBucket: string;
	keyArn: string;
	topicArn: string;
	logGroup: string;
	releaseKeys: ReleaseKey[];
	pins: string;
	/** Static scripts and units shipped in user data, keyed by install path. */
	files: HostFile[];
}

/** EC2 rejects user data over 16 KB before base64 encoding. */
export const USER_DATA_LIMIT = 16 * 1024;

const PATH = /^\/[A-Za-z0-9._/-]+$/;
const MODE = /^0[0-7]{3}$/;

/** The parts of the user data, in order. Tokens stay separate strings for Fn::Join. */
export function userDataParts(input: UserDataInput): string[] {
	const files: HostFile[] = [
		{
			path: "/etc/memory-anywhere/stack.env",
			mode: "0644",
			content: "", // filled with tokens below
		},
		{ path: "/etc/memory-anywhere/pins.env", mode: "0644", content: input.pins },
		...input.releaseKeys.map((k) => ({
			path: `/etc/memory-anywhere/release-keys/${k.name}`,
			mode: "0644",
			content: k.content,
		})),
		...input.files,
	];
	const parts: string[] = ["#!/bin/bash\nset -euo pipefail\numask 022\n"];
	files.forEach((f, i) => {
		if (!PATH.test(f.path)) throw new Error(`unsafe user-data path ${f.path}`);
		if (!MODE.test(f.mode)) throw new Error(`bad mode ${f.mode} for ${f.path}`);
		// The delimiter cannot occur in base64 text (it has underscores), nor in stack.env (generated here).
		const delimiter = `MA_USER_DATA_EOF_${i}`;
		const dir = f.path.slice(0, f.path.lastIndexOf("/"));
		parts.push(`install -d -m 0755 ${dir}\n`);
		if (f.path === "/etc/memory-anywhere/stack.env") {
			parts.push(`cat > ${f.path} <<'${delimiter}'\n`, ...stackEnv(input));
		} else {
			parts.push(
				`base64 -d <<'${delimiter}' | gunzip > ${f.path}\n`,
				packed(f.content.endsWith("\n") ? f.content : `${f.content}\n`),
			);
		}
		parts.push(`${delimiter}\nchmod ${f.mode} ${f.path}\n`);
	});
	parts.push("exec /usr/local/sbin/ma-firstboot\n");
	return parts;
}

/** gzip then base64 in 76-column lines. Node's gzip header carries no timestamp, so the same
 * content always packs to the same text and an unchanged file never changes the template. */
function packed(content: string): string {
	const b64 = gzipSync(Buffer.from(content, "utf8"), { level: 9 }).toString("base64");
	return `${b64.replace(/.{1,76}/g, "$&\n")}`;
}

function stackEnv(input: UserDataInput): string[] {
	const entries: [string, string][] = [
		["MA_STAGE", input.stage],
		["MA_PREFIX", input.prefix],
		["MA_REGION", input.region],
		["MA_HOST", input.host],
		["MA_ALERT_EMAIL", input.alertEmail],
		["MA_OWNER_TZ", input.ownerTimezone],
		["MA_RELEASES_BUCKET", input.releasesBucket],
		["MA_BACKUP_BUCKET", input.backupBucket],
		["MA_KEY_ARN", input.keyArn],
		["MA_TOPIC_ARN", input.topicArn],
		["MA_LOG_GROUP", input.logGroup],
	];
	const out: string[] = ["# Written by user data from the stack's parameters and outputs.\n"];
	for (const [k, v] of entries) out.push(`${k}=`, v, "\n");
	return out;
}

export function buildUserData(input: UserDataInput): string {
	return Fn.base64(Fn.join("", userDataParts(input)));
}
