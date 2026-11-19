// How the owner hears about trouble: one SNS topic mailed to the alert address, fed by log-based
// alarms, the instance's status check, the monthly budget and (on prod) cost anomaly detection.

import { Duration, type CfnParameter } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { names } from "../names.ts";
import type { StackContext } from "./context.ts";

export function alertsTopic({ scope, stage }: StackContext, alertEmail: CfnParameter): sns.Topic {
	const topic = new sns.Topic(scope, "Alerts", { topicName: names.alertsTopic(stage) });
	new sns.Subscription(scope, "AlertsEmail", {
		topic,
		protocol: sns.SubscriptionProtocol.EMAIL,
		endpoint: alertEmail.valueAsString,
	});
	return topic;
}

/** Log lines the server writes that should wake the owner: how many, within how many minutes. */
const LOG_ALARMS: readonly { name: string; pattern: logs.IFilterPattern; threshold: number; minutes: number }[] = [
	{ name: "ma_5xx", pattern: logs.FilterPattern.numberValue("$.status", ">=", 500), threshold: 5, minutes: 5 },
	{
		name: "ma_auth_fail",
		pattern: logs.FilterPattern.stringValue("$.reason", "=", "auth_fail"),
		threshold: 5,
		minutes: 10,
	},
	{
		name: "ma_backup_lag",
		pattern: logs.FilterPattern.stringValue("$.reason", "=", "backup_lag"),
		threshold: 1,
		minutes: 5,
	},
];

export function alarms(
	{ scope, stage }: StackContext,
	topic: sns.Topic,
	logGroup: logs.LogGroup,
	instance: ec2.CfnInstance,
): void {
	const namespace = `memory-anywhere/${stage}`;
	const alarmAction = new cwActions.SnsAction(topic);
	for (const f of LOG_ALARMS) {
		const metric = new logs.MetricFilter(scope, `Filter_${f.name}`, {
			logGroup,
			filterName: f.name,
			filterPattern: f.pattern,
			metricNamespace: namespace,
			metricName: f.name,
			metricValue: "1",
			defaultValue: 0,
		}).metric({ statistic: "Sum", period: Duration.minutes(f.minutes) });
		new cloudwatch.Alarm(scope, `Alarm_${f.name}`, {
			alarmName: names.alarm(stage, f.name),
			metric,
			threshold: f.threshold,
			evaluationPeriods: 1,
			comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(alarmAction);
	}
	new cloudwatch.Alarm(scope, "Alarm_status_check", {
		alarmName: names.alarm(stage, "status-check"),
		metric: new cloudwatch.Metric({
			namespace: "AWS/EC2",
			metricName: "StatusCheckFailed",
			dimensionsMap: { InstanceId: instance.ref },
			statistic: "Maximum",
			period: Duration.minutes(5),
		}),
		threshold: 1,
		evaluationPeriods: 2,
		comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
		treatMissingData: cloudwatch.TreatMissingData.BREACHING,
	}).addAlarmAction(alarmAction);
}

/** A 30 USD monthly budget (warned at a 25 USD forecast) and, on prod, an anomaly monitor. */
export function costWatch({ scope, stage, isProd }: StackContext, topic: sns.Topic): void {
	const toTopic = [{ subscriptionType: "SNS", address: topic.topicArn }];
	const above = (notificationType: string, threshold: number) => ({
		notification: { notificationType, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "ABSOLUTE_VALUE" },
		subscribers: toTopic,
	});
	new budgets.CfnBudget(scope, "Budget", {
		budget: {
			budgetName: names.budget(stage),
			budgetType: "COST",
			timeUnit: "MONTHLY",
			budgetLimit: { amount: 30, unit: "USD" },
		},
		notificationsWithSubscribers: [above("FORECASTED", 25), above("ACTUAL", 30)],
	});
	// An account holds one AWS-services anomaly monitor, so only prod creates it; it watches the
	// whole account, eval and spike stacks included.
	if (!isProd) return;
	const monitor = new ce.CfnAnomalyMonitor(scope, "AnomalyMonitor", {
		monitorName: names.anomalyMonitor(stage),
		monitorType: "DIMENSIONAL",
		monitorDimension: "SERVICE",
	});
	new ce.CfnAnomalySubscription(scope, "AnomalySubscription", {
		subscriptionName: names.anomalyMonitor(stage),
		// SNS subscribers require IMMEDIATE (Cost Anomaly Detection API).
		frequency: "IMMEDIATE",
		monitorArnList: [monitor.attrMonitorArn],
		subscribers: [{ type: "SNS", address: topic.topicArn }],
		thresholdExpression: JSON.stringify({
			Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["5"] },
		}),
	});
}

/** Who may publish to the topic: the instance, and the AWS services behind the alarms above. */
export function topicPublishers({ isProd, account }: StackContext, topic: sns.Topic, instanceRole: iam.Role): void {
	topic.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "InstanceRole",
			principals: [new iam.ArnPrincipal(instanceRole.roleArn)],
			actions: ["sns:Publish"],
			resources: [topic.topicArn],
		}),
	);
	topic.addToResourcePolicy(
		new iam.PolicyStatement({
			sid: "AwsServices",
			principals: [
				new iam.ServicePrincipal("budgets.amazonaws.com"),
				new iam.ServicePrincipal("events.amazonaws.com"),
				new iam.ServicePrincipal("cloudwatch.amazonaws.com"),
			],
			actions: ["sns:Publish"],
			resources: [topic.topicArn],
			conditions: { StringEquals: { "aws:SourceAccount": account } },
		}),
	);
	// Cost Anomaly Detection validates the topic against AWS's documented policy, which has no
	// source condition; a mismatch would roll back the whole stack.
	if (isProd) {
		topic.addToResourcePolicy(
			new iam.PolicyStatement({
				sid: "CostAnomalyDetection",
				principals: [new iam.ServicePrincipal("costalerts.amazonaws.com")],
				actions: ["sns:Publish"],
				resources: [topic.topicArn],
			}),
		);
	}
}
