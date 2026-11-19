// The audit trail (deployment-aws.md §2): CloudTrail records every management call, and EventBridge
// mails the owner the moment someone touches the key, a bucket's controls, IAM, the stack, the
// instance, a release or the stage's parameters.

import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as events from "aws-cdk-lib/aws-events";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as sns from "aws-cdk-lib/aws-sns";
import { names, stackName } from "../names.ts";
import type { StackContext } from "./context.ts";

const API_CALL = "AWS API Call via CloudTrail";

export function audit(
	{ scope, stage, prefix }: StackContext,
	trailBucket: s3.Bucket,
	releasesBucket: s3.Bucket,
	topic: sns.Topic,
): void {
	const trail = new cloudtrail.Trail(scope, "Trail", {
		trailName: names.trail(stage),
		bucket: trailBucket,
		isMultiRegionTrail: true,
		includeGlobalServiceEvents: true,
		managementEvents: cloudtrail.ReadWriteType.ALL,
		sendToCloudWatchLogs: false,
	});
	trail.addS3EventSelector([{ bucket: releasesBucket }], {
		readWriteType: cloudtrail.ReadWriteType.WRITE_ONLY,
		includeManagementEvents: true,
	});

	const rules: { name: string; pattern: events.EventPattern }[] = [
		{
			name: "kms-key-changes",
			pattern: {
				source: ["aws.kms"],
				detailType: [API_CALL],
				detail: { eventName: ["ScheduleKeyDeletion", "DisableKey", "PutKeyPolicy"] },
			},
		},
		{
			name: "bucket-controls",
			pattern: {
				source: ["aws.s3"],
				detailType: [API_CALL],
				detail: {
					eventName: [
						"PutBucketPolicy",
						"DeleteBucketPolicy",
						"PutBucketVersioning",
						"PutBucketLifecycle",
						"PutBucketLifecycleConfiguration",
					],
				},
			},
		},
		{
			name: "iam-changes",
			pattern: {
				source: ["aws.iam"],
				detailType: [API_CALL],
				detail: {
					eventName: [
						"CreatePolicy",
						"CreatePolicyVersion",
						"DeletePolicy",
						"DeletePolicyVersion",
						"SetDefaultPolicyVersion",
						"CreateRole",
						"DeleteRole",
						"UpdateAssumeRolePolicy",
						"PutRolePolicy",
						"DeleteRolePolicy",
						"AttachRolePolicy",
						"DetachRolePolicy",
						"PutRolePermissionsBoundary",
						"DeleteRolePermissionsBoundary",
					],
				},
			},
		},
		{
			name: "console-login-outside-identity-center",
			pattern: {
				source: ["aws.signin"],
				detailType: ["AWS Console Sign In via CloudTrail"],
				detail: { userIdentity: { type: ["Root", "IAMUser"] } },
			},
		},
		{
			name: "stack-changes",
			pattern: {
				source: ["aws.cloudformation"],
				detailType: [API_CALL],
				detail: {
					eventName: ["CreateStack", "UpdateStack", "ExecuteChangeSet", "DeleteStack"],
					requestParameters: { stackName: [{ wildcard: `*${stackName(stage)}*` }] },
				},
			},
		},
		{
			name: "instance-changes",
			pattern: {
				source: ["aws.ec2"],
				detailType: [API_CALL],
				detail: { eventName: ["ModifyInstanceAttribute", "RunInstances", "TerminateInstances"] },
			},
		},
		{
			name: "release-and-key-parameters",
			pattern: {
				source: ["aws.ssm"],
				detailType: [API_CALL],
				detail: {
					eventName: ["PutParameter"],
					requestParameters: { name: [`${prefix}/release/desired`, { prefix: `${prefix}/llm/` }] },
				},
			},
		},
		{
			name: "sessions-and-commands",
			pattern: { source: ["aws.ssm"], detailType: [API_CALL], detail: { eventName: ["SendCommand", "StartSession"] } },
		},
		{
			name: "release-uploads",
			pattern: {
				source: ["aws.s3"],
				detailType: [API_CALL],
				detail: { eventName: ["PutObject"], requestParameters: { bucketName: [releasesBucket.bucketName] } },
			},
		},
	];
	for (const r of rules) {
		new events.CfnRule(scope, `Rule_${r.name}`, {
			name: names.rule(stage, r.name),
			state: "ENABLED",
			eventPattern: renderPattern(r.pattern),
			targets: [{ id: "alerts", arn: topic.topicArn }],
		});
	}
}

/** CloudFormation wants the raw EventBridge pattern (detail-type, not detailType). */
function renderPattern(p: events.EventPattern): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (p.source) out["source"] = p.source;
	if (p.detailType) out["detail-type"] = p.detailType;
	if (p.detail) out["detail"] = p.detail;
	return out;
}
