// The server's machine (deployment-aws.md §3.5): its role with one inline policy and a permissions
// boundary, its log group, the instance itself with an Elastic IP, and daily snapshots of its disk.

import { Aws, type CfnParameter } from "aws-cdk-lib";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sns from "aws-cdk-lib/aws-sns";
import { TAG_STAGE, names } from "../names.ts";
import { buildUserData, type HostFile, type ReleaseKey } from "../user-data.ts";
import type { StackContext } from "./context.ts";
import type { Network } from "./network.ts";
import type { Storage } from "./storage.ts";

export interface InstanceAccess {
	readonly instanceRole: iam.Role;
	readonly logGroup: logs.LogGroup;
	readonly dlmRole: iam.Role;
}

/** The roles the instance and its snapshots run as, and the log group the server ships to. */
export function instanceAccess(c: StackContext, s: Storage, topic: sns.Topic): InstanceAccess {
	const { scope, stage, removal, account, region, prefix, principals } = c;
	const instanceRole = new iam.Role(scope, "InstanceRole", {
		roleName: names.instanceRole(stage),
		assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
		permissionsBoundary: principals.boundary,
		description: `memory-anywhere ${stage} instance (root agents, Litestream, ma-aws helpers)`,
	});
	const logGroup = new logs.LogGroup(scope, "ServerLogs", {
		logGroupName: names.logGroup(stage),
		retention: logs.RetentionDays.ONE_MONTH,
		removalPolicy: removal,
	});
	const paramArn = (path: string) => `arn:${Aws.PARTITION}:ssm:${region}:${account}:parameter${prefix}/${path}`;
	new iam.Policy(scope, "InstancePolicy", {
		roles: [instanceRole],
		statements: [
			new iam.PolicyStatement({
				sid: "SessionManagerAndRunCommand",
				actions: [
					"ssm:UpdateInstanceInformation",
					"ssmmessages:CreateControlChannel",
					"ssmmessages:CreateDataChannel",
					"ssmmessages:OpenControlChannel",
					"ssmmessages:OpenDataChannel",
					"ec2messages:*",
				],
				resources: ["*"],
			}),
			new iam.PolicyStatement({
				sid: "ReadStageParameters",
				actions: ["ssm:GetParameter", "ssm:GetParameters"],
				resources: [paramArn("*")],
			}),
			new iam.PolicyStatement({
				sid: "WriteOutboxParameters",
				actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
				resources: [paramArn("setup-token"), paramArn("acme/account-uri")],
			}),
			new iam.PolicyStatement({ sid: "PublishAlerts", actions: ["sns:Publish"], resources: [topic.topicArn] }),
			new iam.PolicyStatement({
				sid: "ListBuckets",
				actions: ["s3:GetBucketLocation", "s3:ListBucket"],
				resources: [s.backupBucket.bucketArn, s.releasesBucket.bucketArn],
			}),
			new iam.PolicyStatement({
				sid: "LitestreamReplica",
				actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
				resources: [s.backupBucket.arnForObjects("litestream/*")],
			}),
			new iam.PolicyStatement({
				sid: "TransferFetch",
				actions: ["s3:GetObject", "s3:DeleteObject"],
				resources: [s.backupBucket.arnForObjects("transfer/*")],
			}),
			new iam.PolicyStatement({
				sid: "ReadReleases",
				actions: ["s3:GetObject"],
				resources: [s.releasesBucket.arnForObjects("*")],
			}),
			// The manifest job stores today's and reads the newest; a restore reads the one it checks against.
			new iam.PolicyStatement({
				sid: "Manifests",
				actions: ["s3:PutObject", "s3:GetObject"],
				resources: [s.manifestBucket.arnForObjects("manifests/*")],
			}),
			new iam.PolicyStatement({
				sid: "ListManifests",
				actions: ["s3:ListBucket"],
				resources: [s.manifestBucket.bucketArn],
				conditions: { StringEquals: { "s3:prefix": "manifests/" } },
			}),
			new iam.PolicyStatement({
				sid: "KeyViaS3",
				actions: ["kms:GenerateDataKey", "kms:Decrypt"],
				resources: [s.key.keyArn],
				conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
			}),
			new iam.PolicyStatement({
				sid: "ShipLogs",
				actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
				// log-group:<name>:* covers the group and every stream in it.
				resources: [`arn:${Aws.PARTITION}:logs:${region}:${account}:log-group:${names.logGroup(stage)}:*`],
			}),
		],
	});

	const dlmRole = new iam.Role(scope, "DlmRole", {
		roleName: names.dlmRole(stage),
		assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
		permissionsBoundary: principals.boundary,
		managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole")],
		description: `memory-anywhere ${stage} daily EBS snapshots`,
	});
	return { instanceRole, logGroup, dlmRole };
}

export interface InstanceSpec {
	/** AL2023 arm64 AMI for the stack's region. */
	readonly amiId: string;
	readonly releaseKeys: ReleaseKey[];
	readonly pins: string;
	readonly hostFiles: HostFile[];
	/** Raised to build a new instance; 0 keeps the original launch template. */
	readonly instanceGeneration: number;
	readonly host: CfnParameter;
	readonly alertEmail: CfnParameter;
	readonly ownerTimezone: CfnParameter;
}

export interface Server {
	readonly instance: ec2.CfnInstance;
	readonly eip: ec2.CfnEIP;
}

/** The instance, launched from a template whose user data installs and starts the server. */
export function server(
	c: StackContext,
	spec: InstanceSpec,
	n: Network,
	s: Storage,
	a: InstanceAccess,
	topic: sns.Topic,
): Server {
	const { scope, stage, region, prefix } = c;
	const profile = new iam.CfnInstanceProfile(scope, "InstanceProfile", {
		instanceProfileName: names.instanceProfile(stage),
		roles: [a.instanceRole.roleName],
	});
	const stageTags = [{ key: TAG_STAGE, value: stage }];
	const userData = buildUserData({
		stage,
		prefix,
		region,
		host: spec.host.valueAsString,
		alertEmail: spec.alertEmail.valueAsString,
		ownerTimezone: spec.ownerTimezone.valueAsString,
		releasesBucket: s.releasesBucket.bucketName,
		backupBucket: s.backupBucket.bucketName,
		keyArn: s.key.keyArn,
		topicArn: topic.topicArn,
		logGroup: a.logGroup.logGroupName,
		releaseKeys: spec.releaseKeys,
		pins: spec.pins,
		files: spec.hostFiles,
	});
	const launchTemplate = new ec2.CfnLaunchTemplate(scope, "LaunchTemplate", {
		launchTemplateName: names.launchTemplate(stage),
		launchTemplateData: {
			imageId: spec.amiId,
			instanceType: "t4g.small",
			creditSpecification: { cpuCredits: "standard" },
			iamInstanceProfile: { arn: profile.attrArn },
			metadataOptions: {
				httpTokens: "required",
				httpPutResponseHopLimit: 1,
				httpEndpoint: "enabled",
				instanceMetadataTags: "disabled",
			},
			monitoring: { enabled: false },
			blockDeviceMappings: [
				{
					deviceName: "/dev/xvda",
					ebs: {
						volumeType: "gp3",
						volumeSize: 20,
						encrypted: true,
						kmsKeyId: s.key.keyArn,
						deleteOnTermination: true,
					},
				},
			],
			tagSpecifications: [
				{
					resourceType: "instance",
					tags: [
						...stageTags,
						{ key: "Name", value: `memory-anywhere-${stage}` },
						// A new generation is a new launch template version, so a new instance (inputs.ts).
						...(spec.instanceGeneration > 0
							? [{ key: "memory-anywhere:generation", value: String(spec.instanceGeneration) }]
							: []),
					],
				},
				{ resourceType: "volume", tags: [...stageTags, { key: "Name", value: `memory-anywhere-${stage}-root` }] },
			],
			userData,
		},
	});
	const instance = new ec2.CfnInstance(scope, "Instance", {
		launchTemplate: { launchTemplateId: launchTemplate.ref, version: launchTemplate.attrLatestVersionNumber },
		subnetId: n.subnet.subnetId,
		securityGroupIds: [n.securityGroup.securityGroupId],
	});
	const eip = new ec2.CfnEIP(scope, "ElasticIp", { domain: "vpc" });
	new ec2.CfnEIPAssociation(scope, "ElasticIpAssociation", {
		allocationId: eip.attrAllocationId,
		instanceId: instance.ref,
	});

	new dlm.CfnLifecyclePolicy(scope, "DailySnapshots", {
		// DLM allows only [0-9A-Za-z _-] here.
		description: `memory-anywhere ${stage} root volume daily 0500 UTC keep 7`,
		state: "ENABLED",
		executionRoleArn: a.dlmRole.roleArn,
		policyDetails: {
			policyType: "EBS_SNAPSHOT_MANAGEMENT",
			resourceTypes: ["VOLUME"],
			targetTags: stageTags,
			schedules: [
				{
					name: "daily",
					copyTags: true,
					createRule: { interval: 24, intervalUnit: "HOURS", times: ["05:00"] },
					retainRule: { count: 7 },
				},
			],
		},
	});
	return { instance, eip };
}
