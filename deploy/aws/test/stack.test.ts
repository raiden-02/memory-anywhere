import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";
import { DEPLOY_AWS_DIR, loadStackInputs, readReleaseKeys } from "../lib/inputs.ts";
import { MemoryAnywhereStack } from "../lib/stack.ts";
import { USER_DATA_LIMIT, userDataParts } from "../lib/user-data.ts";
import type { Stage } from "../lib/names.ts";

const AMI_PINS = { "us-east-1": "ami-0123456789abcdef0" };

// Prod is synthesized with a stand-in release key (deployment-aws.md §7.4) so its policies can be
// tested without the real one.
const FAKE_RELEASE_KEY = { name: "release.pub", content: "untrusted comment: test\nRW" + "A".repeat(54) + "\n" };

// The spike and eval stages trust the user's own dev key, read from their data folder; a stand-in here.
const DEV_KEY_DIR = mkdtempSync(join(tmpdir(), "ma dev key "));
const DEV_KEY_FILE = join(DEV_KEY_DIR, "dev-release.pub");
writeFileSync(DEV_KEY_FILE, "untrusted comment: dev\nRW" + "B".repeat(54) + "\n");
afterAll(() => rmSync(DEV_KEY_DIR, { recursive: true, force: true }));

// Synthesize with the same feature flags as `cdk synth` (validation errors fail the test).
const CDK_CONTEXT = (
	JSON.parse(readFileSync(join(DEPLOY_AWS_DIR, "cdk.json"), "utf8")) as { context: Record<string, unknown> }
).context;

function synth(stage: Stage, instanceGeneration?: string): Template {
	const app = new App({ context: CDK_CONTEXT });
	const spikeInputs = loadStackInputs({
		stage: "spike",
		region: "us-east-1",
		amiPins: AMI_PINS,
		instanceGeneration,
		devKeyFile: DEV_KEY_FILE,
	});
	const inputs = stage === "spike" ? spikeInputs : { ...spikeInputs, stage, releaseKeys: [FAKE_RELEASE_KEY] };
	return Template.fromStack(new MemoryAnywhereStack(app, { ...inputs, env: { region: inputs.region } }));
}

const spike = synth("spike");
const spikeJson = JSON.stringify(spike.toJSON());

type Statement = {
	Sid?: string;
	Effect: string;
	Action?: string | string[];
	NotAction?: string | string[];
	Condition?: Record<string, Record<string, unknown>>;
};

function bucketPolicyStatements(t: Template, logicalPrefix: string): Statement[] {
	const policies = t.findResources("AWS::S3::BucketPolicy");
	const entry = Object.entries(policies).find(([id]) => id.startsWith(logicalPrefix));
	if (!entry) throw new Error(`no bucket policy ${logicalPrefix}`);
	return (entry[1] as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument
		.Statement;
}

describe("spike stack", () => {
	it("uses only resource types the cfn-exec policies were written for, and no Lambda", () => {
		const allowed = new Set([
			"AWS::EC2::VPC",
			"AWS::EC2::Subnet",
			"AWS::EC2::RouteTable",
			"AWS::EC2::SubnetRouteTableAssociation",
			"AWS::EC2::Route",
			"AWS::EC2::InternetGateway",
			"AWS::EC2::VPCGatewayAttachment",
			"AWS::EC2::VPCEndpoint",
			"AWS::EC2::SecurityGroup",
			"AWS::EC2::LaunchTemplate",
			"AWS::EC2::Instance",
			"AWS::EC2::EIP",
			"AWS::EC2::EIPAssociation",
			"AWS::IAM::Role",
			"AWS::IAM::Policy",
			"AWS::IAM::InstanceProfile",
			"AWS::KMS::Key",
			"AWS::KMS::Alias",
			"AWS::S3::Bucket",
			"AWS::S3::BucketPolicy",
			"AWS::SNS::Topic",
			"AWS::SNS::Subscription",
			"AWS::SNS::TopicPolicy",
			"AWS::Logs::LogGroup",
			"AWS::Logs::MetricFilter",
			"AWS::CloudWatch::Alarm",
			"AWS::DLM::LifecyclePolicy",
			"AWS::Budgets::Budget",
			"AWS::CE::AnomalyMonitor",
			"AWS::CE::AnomalySubscription",
			"AWS::CloudTrail::Trail",
			"AWS::Events::Rule",
		]);
		const types = new Set(
			Object.values(spike.toJSON()["Resources"] as Record<string, { Type: string }>).map((r) => r.Type),
		);
		expect([...types].filter((t) => !allowed.has(t))).toEqual([]);
		expect(spikeJson).not.toMatch(/Custom::|AWS::Lambda::/);
	});

	it("takes the hostname and alert email only as parameters, and no SSM-resolved ones", () => {
		spike.hasParameter("Host", { Type: "String" });
		spike.hasParameter("AlertEmail", { Type: "String" });
		// CloudFormation resolves SSM parameter types with the cfn-exec role, which may not read them.
		expect(Object.keys(spike.toJSON()["Parameters"] as object).sort()).toEqual(["AlertEmail", "Host", "OwnerTimezone"]);
		const tz = (spike.toJSON()["Parameters"] as Record<string, { AllowedPattern: string; Default: string }>)[
			"OwnerTimezone"
		];
		expect(tz?.Default).toBe("UTC");
		const re = new RegExp(tz?.AllowedPattern ?? "");
		for (const ok of ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+5"])
			expect(re.test(ok)).toBe(true);
		for (const bad of ["", "Europe/Berlin; rm -rf /", "../etc", "a b"]) expect(re.test(bad)).toBe(false);
		expect(spikeJson).not.toContain("AWS::SSM::Parameter::Value");
		expect(spikeJson).not.toMatch(/example\.com|@gmail|memory\.[a-z]+\.(com|org|net)/);
	});

	it("opens 443 in, and only 443 and NTP out", () => {
		spike.hasResourceProperties("AWS::EC2::SecurityGroup", {
			SecurityGroupIngress: [
				{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
				{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIpv6: "::/0" },
			],
			SecurityGroupEgress: [
				{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
				{ IpProtocol: "udp", FromPort: 123, ToPort: 123, CidrIp: "0.0.0.0/0" },
			],
		});
	});

	it("launches t4g.small with IMDSv2 hop 1, standard credits and a CMK-encrypted gp3 root", () => {
		spike.hasResourceProperties("AWS::EC2::LaunchTemplate", {
			LaunchTemplateData: Match.objectLike({
				InstanceType: "t4g.small",
				ImageId: "ami-0123456789abcdef0",
				CreditSpecification: { CpuCredits: "standard" },
				MetadataOptions: {
					HttpTokens: "required",
					HttpPutResponseHopLimit: 1,
					HttpEndpoint: "enabled",
					InstanceMetadataTags: "disabled",
				},
				Monitoring: { Enabled: false },
				BlockDeviceMappings: [
					Match.objectLike({
						DeviceName: "/dev/xvda",
						Ebs: Match.objectLike({ VolumeType: "gp3", VolumeSize: 20, Encrypted: true, KmsKeyId: Match.anyValue() }),
					}),
				],
			}),
		});
		spike.resourcePropertiesCountIs(
			"AWS::EC2::LaunchTemplate",
			{ LaunchTemplateData: Match.objectLike({ KeyName: Match.anyValue() }) },
			0,
		);
	});

	it("gives every role the permissions boundary and the instance role no managed policy", () => {
		const roles = spike.findResources("AWS::IAM::Role");
		expect(Object.keys(roles)).toHaveLength(2);
		for (const r of Object.values(roles) as { Properties: Record<string, unknown> }[]) {
			expect(JSON.stringify(r.Properties["PermissionsBoundary"])).toContain(":policy/memory-anywhere-boundary");
			expect(r.Properties["RoleName"]).toMatch(/^memory-anywhere-(instance|dlm)-spike$/);
		}
		spike.hasResourceProperties("AWS::IAM::Role", {
			RoleName: "memory-anywhere-instance-spike",
			ManagedPolicyArns: Match.absent(),
		});
		spike.hasResourceProperties("AWS::IAM::Role", {
			RoleName: "memory-anywhere-dlm-spike",
			ManagedPolicyArns: [
				{
					"Fn::Join": [
						"",
						["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"],
					],
				},
			],
		});
	});

	it("scopes the instance policy as in deployment-aws.md §3.5", () => {
		const policy = Object.values(spike.findResources("AWS::IAM::Policy"))[0] as {
			Properties: { PolicyDocument: { Statement: Statement[] } };
		};
		const bySid = new Map(policy.Properties.PolicyDocument.Statement.map((s) => [s.Sid, s]));
		expect([...bySid.keys()].sort()).toEqual(
			[
				"KeyViaS3",
				"ListBuckets",
				"ListManifests",
				"LitestreamReplica",
				"Manifests",
				"PublishAlerts",
				"ReadReleases",
				"ReadStageParameters",
				"SessionManagerAndRunCommand",
				"ShipLogs",
				"TransferFetch",
				"WriteOutboxParameters",
			].sort(),
		);
		// The manifests: put and get under manifests/ only, never delete; list only that prefix.
		expect(bySid.get("Manifests")?.Action).toEqual(["s3:PutObject", "s3:GetObject"]);
		expect(JSON.stringify(bySid.get("Manifests"))).toContain('"ManifestBucket');
		expect(JSON.stringify(bySid.get("Manifests"))).toContain("/manifests/*");
		expect(bySid.get("ListManifests")?.Condition).toEqual({ StringEquals: { "s3:prefix": "manifests/" } });
		const all = JSON.stringify(policy);
		expect(all).not.toContain("s3:DeleteObjectVersion");
		expect(all).toContain("/memory-anywhere-spike/");
		expect(bySid.get("KeyViaS3")?.Condition).toEqual({
			StringEquals: { "kms:ViaService": { "Fn::Join": ["", ["s3.", { Ref: "AWS::Region" }, ".amazonaws.com"]] } },
		});
	});

	it("protects the backup bucket as in deployment-aws.md §5.2 (non-prod)", () => {
		const st = bucketPolicyStatements(spike, "BackupBucketPolicy");
		const sids = st.map((s) => s.Sid ?? "(ssl)");
		expect(sids).toEqual(
			expect.arrayContaining([
				"OnlyStackPrincipals",
				"DeployMayOnlyEmptyNonProd",
				"InstanceOnlyThroughTheGatewayEndpoint",
				"BucketControlsOnlyRootAndCfnExec",
				"PutOnlyWithTheStackKey",
				"PutOnlySseKms",
			]),
		);
		expect(sids).not.toContain("ProdVersionsOnlyRoot");
		expect(
			st.some(
				(s) =>
					s.Effect === "Deny" &&
					JSON.stringify(s.Condition) === JSON.stringify({ Bool: { "aws:SecureTransport": "false" } }),
			),
		).toBe(true);
		for (const s of st) expect(s.Effect).toBe("Deny");
		const only = st.find((s) => s.Sid === "OnlyStackPrincipals");
		expect(only?.NotAction).toEqual(["s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion"]);
		expect(JSON.stringify(only)).not.toContain("memory-anywhere-deploy");
		expect(JSON.stringify(st.find((s) => s.Sid === "DeployMayOnlyEmptyNonProd"))).toContain(
			"AWSReservedSSO_memory-anywhere-deploy_",
		);
	});

	it("encrypts the backup bucket with the CMK and expires noncurrent versions after 14 days", () => {
		spike.hasResourceProperties("AWS::S3::Bucket", {
			VersioningConfiguration: { Status: "Enabled" },
			BucketEncryption: {
				ServerSideEncryptionConfiguration: [
					{
						BucketKeyEnabled: true,
						ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: Match.anyValue() },
					},
				],
			},
			LifecycleConfiguration: {
				Rules: [
					Match.objectLike({
						NoncurrentVersionExpiration: { NoncurrentDays: 14 },
						AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
					}),
				],
			},
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			},
			OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
		});
	});

	it("has a rotating CMK with a 30-day window and the §3.6 statements; spike buckets and key are deletable", () => {
		spike.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true, PendingWindowInDays: 30 });
		const key = Object.values(spike.findResources("AWS::KMS::Key"))[0] as {
			DeletionPolicy: string;
			Properties: { KeyPolicy: { Statement: Statement[] } };
		};
		expect(key.DeletionPolicy).toBe("Delete");
		expect(key.Properties.KeyPolicy.Statement.map((s) => s.Sid).filter(Boolean)).toEqual(
			expect.arrayContaining([
				"InstanceRoleViaS3OnBackupBucket",
				"EbsGrantsForLaunchAndSnapshots",
				"EbsUseForLaunchAndSnapshots",
				"OperatorRestoreViaS3",
			]),
		);
		expect(JSON.stringify(key)).not.toContain("memory-anywhere-deploy");
		spike.hasResource("AWS::KMS::Alias", { Properties: { AliasName: "alias/memory-anywhere-spike" } });
	});

	it("names every rule, alarm, trail and budget so the cfn-exec ARN patterns match", () => {
		for (const r of Object.values(spike.findResources("AWS::Events::Rule")) as { Properties: { Name: string } }[])
			expect(r.Properties.Name).toMatch(/^memory-anywhere-spike-/);
		for (const a of Object.values(spike.findResources("AWS::CloudWatch::Alarm")) as {
			Properties: { AlarmName: string };
		}[])
			expect(a.Properties.AlarmName).toMatch(/^memory-anywhere-spike-/);
		spike.hasResourceProperties("AWS::CloudTrail::Trail", { TrailName: "memory-anywhere-spike" });
		spike.hasResourceProperties("AWS::Budgets::Budget", {
			Budget: Match.objectLike({ BudgetName: "memory-anywhere-spike" }),
		});
		spike.hasResourceProperties("AWS::Logs::LogGroup", {
			LogGroupName: "/memory-anywhere/spike/server",
			RetentionInDays: 30,
		});
		spike.hasResourceProperties("AWS::IAM::InstanceProfile", { InstanceProfileName: "memory-anywhere-instance-spike" });
		spike.hasResourceProperties("AWS::SNS::Topic", { TopicName: "memory-anywhere-alerts-spike" });
	});

	it("alerts on cost: $25 forecast, $30 actual; anomalies of $5 or more from prod's account-wide monitor", () => {
		spike.hasResourceProperties("AWS::Budgets::Budget", {
			NotificationsWithSubscribers: [
				Match.objectLike({
					Notification: Match.objectLike({
						NotificationType: "FORECASTED",
						Threshold: 25,
						ThresholdType: "ABSOLUTE_VALUE",
					}),
				}),
				Match.objectLike({
					Notification: Match.objectLike({
						NotificationType: "ACTUAL",
						Threshold: 30,
						ThresholdType: "ABSOLUTE_VALUE",
					}),
				}),
			],
		});
		synth("prod").hasResourceProperties("AWS::CE::AnomalySubscription", {
			Frequency: "IMMEDIATE",
			Subscribers: [Match.objectLike({ Type: "SNS" })],
		});
	});

	it("snapshots the tagged root volume daily at 05:00 UTC and keeps 7", () => {
		spike.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
			PolicyDetails: Match.objectLike({
				ResourceTypes: ["VOLUME"],
				TargetTags: [{ Key: "memory-anywhere:stage", Value: "spike" }],
				Schedules: [
					Match.objectLike({
						CreateRule: { Interval: 24, IntervalUnit: "HOURS", Times: ["05:00"] },
						RetainRule: { Count: 7 },
					}),
				],
			}),
		});
	});

	it("keeps user data under EC2's 16 KB limit on every kind of stage, with room to grow", () => {
		// Eval stages trust two keys, so they are the largest; the token values are the longest real ones.
		for (const stage of ["spike", "eval-abcdefghijkl", "prod"] as const) {
			const text = userDataText(stage);
			expect(Buffer.byteLength(text), stage).toBeLessThan(USER_DATA_LIMIT - 4096);
		}
	});

	it("writes every host file byte for byte, and trusts only the dev key on spike", () => {
		const inputs = loadStackInputs({
			stage: "spike",
			region: "us-east-1",
			amiPins: AMI_PINS,
			devKeyFile: DEV_KEY_FILE,
		});
		const text = userDataText("spike");
		expect(text.startsWith("#!/bin/bash\n")).toBe(true);
		for (const f of [...inputs.hostFiles, { path: "/etc/memory-anywhere/pins.env", content: inputs.pins }]) {
			expect(unpack(text, f.path), f.path).toBe(f.content.endsWith("\n") ? f.content : `${f.content}\n`);
		}
		expect(unpack(text, "/etc/memory-anywhere/release-keys/dev.pub")).toBe(inputs.releaseKeys[0]?.content);
		expect(text).not.toContain("release-keys/release.pub");
		expect(text).toContain("MA_HOST=memory.example.com\n");
		expect(text.trimEnd().endsWith("exec /usr/local/sbin/ma-firstboot")).toBe(true);
	});

	it("packs files deterministically, so an unchanged release never changes the launch template", () => {
		expect(userDataText("spike")).toBe(userDataText("spike"));
	});
});

/** The user data a stage would get, with the longest token values its stack can produce. */
function userDataText(stage: Stage): string {
	const inputs = loadStackInputs({
		stage: "spike",
		region: "ap-southeast-2",
		amiPins: { "ap-southeast-2": AMI_PINS["us-east-1"] },
		devKeyFile: DEV_KEY_FILE,
	});
	const releaseKeys =
		stage === "spike"
			? inputs.releaseKeys
			: stage === "prod"
				? [FAKE_RELEASE_KEY]
				: [...inputs.releaseKeys, FAKE_RELEASE_KEY];
	return userDataParts({
		stage,
		prefix: `/memory-anywhere-${stage}`,
		region: "ap-southeast-2",
		host: "memory.example.com",
		alertEmail: "owner@example.com",
		ownerTimezone: "America/Argentina/Buenos_Aires",
		releasesBucket: `memory-anywhere-releases-111111111111-ap-southeast-2-${stage}`,
		backupBucket: `memory-anywhere-backup-111111111111-ap-southeast-2-${stage}`,
		keyArn: "arn:aws:kms:ap-southeast-2:111111111111:key/00000000-0000-0000-0000-000000000000",
		topicArn: `arn:aws:sns:ap-southeast-2:111111111111:memory-anywhere-alerts-${stage}`,
		logGroup: `/memory-anywhere/${stage}/server`,
		releaseKeys,
		pins: inputs.pins,
		files: inputs.hostFiles,
	}).join("");
}

/** What `base64 -d <<'EOF' | gunzip > <path>` in the user data writes to <path>. */
function unpack(userData: string, path: string): string | undefined {
	const escaped = path.replace(/[.]/g, "\\.");
	const m = new RegExp(
		`base64 -d <<'(MA_USER_DATA_EOF_\\d+)' \\| gunzip > ${escaped}\\n([A-Za-z0-9+/=\\n]*?)\\1\\n`,
	).exec(userData);
	return m?.[2] === undefined ? undefined : gunzipSync(Buffer.from(m[2].replace(/\n/g, ""), "base64")).toString("utf8");
}

describe("cost anomaly monitor", () => {
	it("exists in prod only, since an account holds one", () => {
		synth("prod").resourceCountIs("AWS::CE::AnomalyMonitor", 1);
		for (const stage of ["spike", "eval-a1"] as const) {
			const t = synth(stage);
			t.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
			t.resourceCountIs("AWS::CE::AnomalySubscription", 0);
			expect(JSON.stringify(t.toJSON())).not.toContain("costalerts.amazonaws.com");
		}
	});
});

describe("prod stack", () => {
	const prod = synth("prod");

	it("retains data, keeps prod backup versions for root only and exempts no deploy role", () => {
		const st = bucketPolicyStatements(prod, "BackupBucketPolicy");
		expect(st.map((s) => s.Sid)).toContain("ProdVersionsOnlyRoot");
		expect(st.map((s) => s.Sid)).not.toContain("DeployMayOnlyEmptyNonProd");
		expect(JSON.stringify(st)).not.toContain("memory-anywhere-deploy");
		const key = Object.values(prod.findResources("AWS::KMS::Key"))[0] as { DeletionPolicy: string };
		expect(key.DeletionPolicy).toBe("Retain");
		for (const b of Object.values(prod.findResources("AWS::S3::Bucket")) as { DeletionPolicy: string }[])
			expect(b.DeletionPolicy).toBe("Retain");
	});

	it("locks every manifest for 90 days in compliance mode, where spike stages keep them unlocked", () => {
		const manifestBucket = (t: Template) =>
			Object.entries(t.findResources("AWS::S3::Bucket")).find(([id]) => id.startsWith("ManifestBucket"))?.[1] as
				{ DeletionPolicy: string; Properties: Record<string, unknown> } | undefined;
		const prodManifest = manifestBucket(prod);
		expect(prodManifest?.Properties).toMatchObject({
			VersioningConfiguration: { Status: "Enabled" },
			ObjectLockEnabled: true,
			ObjectLockConfiguration: {
				ObjectLockEnabled: "Enabled",
				Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 90 } },
			},
		});
		expect(prodManifest?.DeletionPolicy).toBe("Retain");
		const spikeManifest = manifestBucket(spike);
		expect(spikeManifest?.Properties["ObjectLockEnabled"]).toBeUndefined();
		expect(spikeManifest?.DeletionPolicy).toBe("Delete");
	});

	it("builds a new instance only when the generation changes, and reports the generation it deployed", () => {
		const instanceTags = (t: Template) =>
			(
				Object.values(t.findResources("AWS::EC2::LaunchTemplate"))[0] as {
					Properties: {
						LaunchTemplateData: {
							TagSpecifications: { ResourceType: string; Tags: { Key: string; Value: string }[] }[];
						};
					};
				}
			).Properties.LaunchTemplateData.TagSpecifications.find((x) => x.ResourceType === "instance")?.Tags ?? [];
		expect(instanceTags(prod).map((x) => x.Key)).not.toContain("memory-anywhere:generation");
		prod.hasOutput("InstanceGeneration", { Value: "0" });
		const replaced = synth("prod", "2");
		expect(instanceTags(replaced)).toContainEqual({ Key: "memory-anywhere:generation", Value: "2" });
		replaced.hasOutput("InstanceGeneration", { Value: "2" });
		expect(() =>
			loadStackInputs({ stage: "prod", region: "us-east-1", amiPins: AMI_PINS, instanceGeneration: "-1" }),
		).toThrow(/instanceGeneration must be a whole number/);
	});

	it("uses the /memory-anywhere/ prefix", () => {
		expect(JSON.stringify(prod.toJSON())).toContain(":parameter/memory-anywhere/");
	});

	it("trusts the committed release key, and refuses to synthesize while a key it trusts does not exist", () => {
		expect(
			loadStackInputs({ stage: "prod", region: "us-east-1", amiPins: AMI_PINS }).releaseKeys.map((k) => k.name),
		).toEqual(["release.pub"]);
		const empty = mkdtempSync(join(tmpdir(), "ma release keys "));
		try {
			expect(() => readReleaseKeys("prod", { dir: empty })).toThrow(/release-keys\/release\.pub does not exist/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("trusts the user's own dev key on spike and eval stages, and never on prod", () => {
		const names = (stage: Stage, devKeyFile?: string) => readReleaseKeys(stage, { devKeyFile }).map((k) => k.name);
		const missing = join(DEV_KEY_DIR, "absent.pub");
		expect(names("prod", DEV_KEY_FILE)).toEqual(["release.pub"]);
		expect(names("eval-abc", DEV_KEY_FILE)).toEqual(["release.pub", "dev.pub"]);
		expect(names("eval-abc", missing)).toEqual(["release.pub"]);
		expect(names("spike", DEV_KEY_FILE)).toEqual(["dev.pub"]);
		expect(() => names("spike", missing)).toThrow(/absent\.pub does not exist; create the pair with: minisign -G/);
		expect(() => names("spike")).toThrow(/pass its public key file as context devReleaseKey/);
		expect(readReleaseKeys("spike", { devKeyFile: DEV_KEY_FILE })[0]?.content).toContain("RW" + "B".repeat(54));
	});

	it("refuses an unpinned region and a malformed stage", () => {
		expect(() => loadStackInputs({ stage: "spike", region: "us-east-2", amiPins: AMI_PINS })).toThrow(
			/no AL2023 arm64 AMI pinned for us-east-2/,
		);
		expect(() => loadStackInputs({ stage: "Prod", region: "us-east-1", amiPins: AMI_PINS })).toThrow(/stage must be/);
	});
});

// A resource whose logical id changes is deleted and created anew on the next deploy, which on prod
// would replace the instance, the key or a bucket. Moving a construct to another scope or renaming
// it changes the id, so the ids are pinned here; update the snapshot only for an intended replacement.
describe("logical ids", () => {
	it.each(["spike", "eval-x1", "prod"] as const)("%s keeps the id of every resource", (stage) => {
		const resources = (synth(stage).toJSON() as { Resources: Record<string, { Type: string }> }).Resources;
		const ids = Object.entries(resources).map(([id, r]) => `${r.Type} ${id}`);
		expect(ids.sort()).toMatchSnapshot();
	});
});
