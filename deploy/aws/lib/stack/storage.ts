// Where the stage keeps its data (deployment-aws.md §3.6, §5.2, §5.4): one KMS key, four buckets,
// and the key and bucket policies that decide who may read or destroy a backup.

import { Aws, Duration } from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { bucketName, names } from "../names.ts";
import { denyUnlessPrincipal, type StackContext } from "./context.ts";

export interface Storage {
	/** Encrypts the backup bucket and the instance's disk. */
	readonly key: kms.Key;
	/** The Litestream replica and transfers. */
	readonly backupBucket: s3.Bucket;
	/** Signed server releases the instance installs. */
	readonly releasesBucket: s3.Bucket;
	readonly trailBucket: s3.Bucket;
	/** The daily store-hash manifests. */
	readonly manifestBucket: s3.Bucket;
}

export function storage({ scope, stage, isProd, removal, account, region }: StackContext): Storage {
	const key = new kms.Key(scope, "Key", {
		alias: names.keyAlias(stage),
		description: `memory-anywhere ${stage}: backups and EBS`,
		enableKeyRotation: true,
		pendingWindow: Duration.days(30),
		removalPolicy: removal,
	});
	const common = {
		blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
		objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
		enforceSSL: true,
		removalPolicy: removal,
	};
	const backupBucket = new s3.Bucket(scope, "BackupBucket", {
		...common,
		bucketName: bucketName("backup", account, region, stage),
		versioned: true,
		encryption: s3.BucketEncryption.KMS,
		encryptionKey: key,
		bucketKeyEnabled: true,
		lifecycleRules: [
			{ noncurrentVersionExpiration: Duration.days(14), abortIncompleteMultipartUploadAfter: Duration.days(1) },
		],
	});
	const releasesBucket = new s3.Bucket(scope, "ReleasesBucket", {
		...common,
		bucketName: bucketName("releases", account, region, stage),
		versioned: true,
		encryption: s3.BucketEncryption.S3_MANAGED,
		lifecycleRules: [
			{ noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(1) },
		],
	});
	const trailBucket = new s3.Bucket(scope, "TrailBucket", {
		...common,
		bucketName: bucketName("trail", account, region, stage),
		encryption: s3.BucketEncryption.S3_MANAGED,
		lifecycleRules: [{ expiration: Duration.days(90), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
	});
	// The manifests hold store hashes only. On prod no one, root included, can change or delete one
	// for 90 days (Object Lock in compliance mode). Other stages keep them unlocked, so `mema destroy`
	// can remove an eval stack the day it ends.
	const manifestBucket = new s3.Bucket(scope, "ManifestBucket", {
		...common,
		bucketName: bucketName("manifest", account, region, stage),
		versioned: true,
		encryption: s3.BucketEncryption.S3_MANAGED,
		...(isProd
			? { objectLockEnabled: true, objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(90)) }
			: {}),
	});
	return { key, backupBucket, releasesBucket, trailBucket, manifestBucket };
}

export interface BackupReaders {
	readonly instanceRole: iam.Role;
	/** Takes the daily EBS snapshots, so it needs the key through EC2. */
	readonly dlmRole: iam.Role;
	/** The instance reaches the backup bucket only through this endpoint. */
	readonly s3Endpoint: ec2.GatewayVpcEndpoint;
}

/** Key and backup-bucket policies: who may use the key, and who may read, write or destroy a backup. */
export function protectBackups(c: StackContext, { key, backupBucket }: Storage, r: BackupReaders): void {
	const { stage, isProd, account, region, principals: p } = c;
	const viaS3 = { "kms:ViaService": `s3.${region}.amazonaws.com` };
	const viaEc2 = { "kms:ViaService": `ec2.${region}.amazonaws.com` };

	// The backup bucket ARN is spelled out: referencing the bucket would make the key depend on the
	// bucket that is encrypted with it.
	const backupArn = `arn:${Aws.PARTITION}:s3:::${bucketName("backup", account, region, stage)}`;
	key.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "InstanceRoleViaS3OnBackupBucket",
			principals: [new iam.ArnPrincipal(r.instanceRole.roleArn)],
			actions: ["kms:GenerateDataKey", "kms:Decrypt"],
			resources: ["*"],
			conditions: {
				StringEquals: viaS3,
				StringLike: { "kms:EncryptionContext:aws:s3:arn": [backupArn, `${backupArn}/*`] },
			},
		}),
	);
	const ebsUsers = [new iam.ArnPrincipal(p.cfnExecRoleArn), new iam.ArnPrincipal(r.dlmRole.roleArn)];
	key.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "EbsGrantsForLaunchAndSnapshots",
			principals: ebsUsers,
			actions: ["kms:CreateGrant"],
			resources: ["*"],
			conditions: { Bool: { "kms:GrantIsForAWSResource": "true" }, StringEquals: viaEc2 },
		}),
	);
	key.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "EbsUseForLaunchAndSnapshots",
			principals: ebsUsers,
			actions: ["kms:GenerateDataKeyWithoutPlaintext", "kms:Decrypt", "kms:DescribeKey", "kms:ReEncrypt*"],
			resources: ["*"],
			conditions: { StringEquals: viaEc2 },
		}),
	);
	key.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "OperatorRestoreViaS3",
			principals: [new iam.AccountRootPrincipal()],
			actions: ["kms:Decrypt"],
			resources: ["*"],
			conditions: { StringEquals: viaS3, ArnLike: { "aws:PrincipalArn": p.operatorRoleArnPattern } },
		}),
	);

	const backupResources = [backupBucket.bucketArn, backupBucket.arnForObjects("*")];
	const always = [r.instanceRole.roleArn, p.operatorRoleArnPattern, p.cfnExecRoleArn, p.accountRootArn];
	const destroyActions = ["s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion"];
	if (isProd) {
		backupBucket.addToResourcePolicy(denyUnlessPrincipal("OnlyStackPrincipals", ["s3:*"], backupResources, always));
	} else {
		backupBucket.addToResourcePolicy(
			denyUnlessPrincipal("OnlyStackPrincipals", destroyActions, backupResources, always, true),
		);
		backupBucket.addToResourcePolicy(
			denyUnlessPrincipal("DeployMayOnlyEmptyNonProd", destroyActions, backupResources, [
				...always,
				p.deployRoleArnPattern,
			]),
		);
	}
	backupBucket.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "InstanceOnlyThroughTheGatewayEndpoint",
			effect: iam.Effect.DENY,
			principals: [new iam.AnyPrincipal()],
			actions: ["s3:*"],
			resources: backupResources,
			conditions: {
				ArnEquals: { "aws:PrincipalArn": r.instanceRole.roleArn },
				StringNotEquals: { "aws:SourceVpce": r.s3Endpoint.vpcEndpointId },
			},
		}),
	);
	backupBucket.addToResourcePolicy(
		denyUnlessPrincipal(
			"BucketControlsOnlyRootAndCfnExec",
			[
				"s3:PutBucketPolicy",
				"s3:DeleteBucketPolicy",
				"s3:PutLifecycleConfiguration",
				"s3:PutBucketVersioning",
				"s3:PutEncryptionConfiguration",
				"s3:PutBucketObjectLockConfiguration",
			],
			[backupBucket.bucketArn],
			[p.accountRootArn, p.cfnExecRoleArn],
		),
	);
	if (isProd) {
		backupBucket.addToResourcePolicy(
			denyUnlessPrincipal("ProdVersionsOnlyRoot", ["s3:DeleteObjectVersion", "s3:DeleteBucket"], backupResources, [
				p.accountRootArn,
			]),
		);
	}
	const putDenied = (sid: string, condition: Record<string, string>) =>
		new iam.PolicyStatement({
			sid,
			effect: iam.Effect.DENY,
			principals: [new iam.AnyPrincipal()],
			actions: ["s3:PutObject"],
			resources: [backupBucket.arnForObjects("*")],
			conditions: { StringNotEquals: condition },
		});
	backupBucket.addToResourcePolicy(
		putDenied("PutOnlyWithTheStackKey", { "s3:x-amz-server-side-encryption-aws-kms-key-id": key.keyArn }),
	);
	backupBucket.addToResourcePolicy(putDenied("PutOnlySseKms", { "s3:x-amz-server-side-encryption": "aws:kms" }));
}
