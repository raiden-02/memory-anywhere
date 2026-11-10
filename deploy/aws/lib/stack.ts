// The memory-anywhere stack (deployment-aws.md §2, §3.5, §3.6, §5.2, §9).
//
// The owner's hostname and alert email are CloudFormation parameters, so the
// synthesized template (and anything committed) never contains them. The stack
// uses no Lambda-backed custom resources: everything here is a plain
// CloudFormation resource that the cfn-exec policies in ../iam/ allow.

import {
  Aws,
  CfnOutput,
  CfnParameter,
  DefaultStackSynthesizer,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import {
  BOUNDARY_POLICY,
  TAG_STAGE,
  bucketName,
  names,
  parameterPrefix,
  stackName,
  stageHost,
  type Stage,
} from "./names.ts";
import { buildUserData, type HostFile, type ReleaseKey } from "./user-data.ts";

export interface MemoryAnywhereStackProps extends StackProps {
  stage: Stage;
  /** AL2023 arm64 AMI for the stack's region, pinned in cdk.context.json. */
  amiId: string;
  /** Public halves of the release keys this stage trusts (§7.4). */
  releaseKeys: ReleaseKey[];
  /** Contents of host/pins.env (pinned binary URLs and hashes). */
  pins: string;
  /** First-boot script, updater and its units (see bin/app.ts). */
  hostFiles: HostFile[];
}

const SSO_OPERATOR_ROLE = "AWSReservedSSO_memory-anywhere-operator_*";
const SSO_DEPLOY_ROLE = "AWSReservedSSO_memory-anywhere-deploy_*";

export class MemoryAnywhereStack extends Stack {
  constructor(scope: Construct, props: MemoryAnywhereStackProps) {
    super(scope, stackName(props.stage), {
      ...props,
      analyticsReporting: false,
      // No BootstrapVersion SSM parameter in the template: CloudFormation would resolve it
      // with the cfn-exec role, which may read only stage parameters. The CDK CLI still
      // checks the bootstrap version itself, through the CDK deploy role.
      synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    });
    const { stage } = props;
    const isProd = stage === "prod";
    const removal = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const account = Aws.ACCOUNT_ID;
    const region = Aws.REGION;
    const prefix = parameterPrefix(stage);
    Tags.of(this).add(TAG_STAGE, stage);

    // ---- Parameters: owner-specific values never enter the template ----
    const host = new CfnParameter(this, "Host", {
      type: "String",
      description: "The owner's subdomain ({host}); the stage serves " + (stage === "prod" ? "{host} and admin.{host}" : stageHost(stage, "{host}")),
      allowedPattern: "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
      constraintDescription: "a lowercase DNS name (the owner's subdomain)",
    });
    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      description: "Address for SNS alerts and the ACME account",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      constraintDescription: "an email address",
    });

    // ---- Principals referenced by policies ----
    const accountRootArn = `arn:${Aws.PARTITION}:iam::${account}:root`;
    const cfnExecRoleArn = `arn:${Aws.PARTITION}:iam::${account}:role/${names.cfnExecRole(account, region)}`;
    const operatorRoleArnPattern = `arn:${Aws.PARTITION}:iam::${account}:role/aws-reserved/sso.amazonaws.com/*${SSO_OPERATOR_ROLE}`;
    const deployRoleArnPattern = `arn:${Aws.PARTITION}:iam::${account}:role/aws-reserved/sso.amazonaws.com/*${SSO_DEPLOY_ROLE}`;
    const boundary = iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", BOUNDARY_POLICY);

    // ---- Network ----
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/24"),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 }],
      restrictDefaultSecurityGroup: false, // would add a Lambda-backed custom resource
    });
    const s3Endpoint = vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const sg = new ec2.SecurityGroup(this, "InstanceSg", {
      vpc,
      description: "memory-anywhere: 443 in; 443 and NTP out",
      allowAllOutbound: false,
      allowAllIpv6Outbound: false,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), "HTTPS");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS (AWS APIs, releases, ACME, DoH)");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(123), "NTP");

    // ---- Key (§3.6) ----
    const key = new kms.Key(this, "Key", {
      alias: names.keyAlias(stage),
      description: `memory-anywhere ${stage}: backups and EBS`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: removal,
    });

    // ---- Alerts ----
    const topic = new sns.Topic(this, "Alerts", { topicName: names.alertsTopic(stage) });
    new sns.Subscription(this, "AlertsEmail", { topic, protocol: sns.SubscriptionProtocol.EMAIL, endpoint: alertEmail.valueAsString });

    // ---- Buckets ----
    const backupBucket = new s3.Bucket(this, "BackupBucket", {
      bucketName: bucketName("backup", account, region, stage),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(14), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: removal,
    });
    const releasesBucket = new s3.Bucket(this, "ReleasesBucket", {
      bucketName: bucketName("releases", account, region, stage),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: removal,
    });
    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      bucketName: bucketName("trail", account, region, stage),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(90), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: removal,
    });

    // ---- Instance role (§3.5): one inline policy, permissions boundary, nothing managed ----
    const instanceRole = new iam.Role(this, "InstanceRole", {
      roleName: names.instanceRole(stage),
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      permissionsBoundary: boundary,
      description: `memory-anywhere ${stage} instance (root agents, Litestream, ma-aws helpers)`,
    });
    const logGroup = new logs.LogGroup(this, "ServerLogs", {
      logGroupName: names.logGroup(stage),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: removal,
    });
    const paramArn = (path: string) => `arn:${Aws.PARTITION}:ssm:${region}:${account}:parameter${prefix}/${path}`;
    new iam.Policy(this, "InstancePolicy", {
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
        new iam.PolicyStatement({ sid: "ReadStageParameters", actions: ["ssm:GetParameter", "ssm:GetParameters"], resources: [paramArn("*")] }),
        new iam.PolicyStatement({
          sid: "WriteOutboxParameters",
          actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
          resources: [paramArn("setup-token"), paramArn("acme/account-uri")],
        }),
        new iam.PolicyStatement({ sid: "PublishAlerts", actions: ["sns:Publish"], resources: [topic.topicArn] }),
        new iam.PolicyStatement({
          sid: "ListBuckets",
          actions: ["s3:GetBucketLocation", "s3:ListBucket"],
          resources: [backupBucket.bucketArn, releasesBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: "LitestreamReplica",
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [backupBucket.arnForObjects("litestream/*")],
        }),
        new iam.PolicyStatement({
          sid: "TransferFetch",
          actions: ["s3:GetObject", "s3:DeleteObject"],
          resources: [backupBucket.arnForObjects("transfer/*")],
        }),
        new iam.PolicyStatement({ sid: "ReadReleases", actions: ["s3:GetObject"], resources: [releasesBucket.arnForObjects("*")] }),
        new iam.PolicyStatement({
          sid: "KeyViaS3",
          actions: ["kms:GenerateDataKey", "kms:Decrypt"],
          resources: [key.keyArn],
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

    const dlmRole = new iam.Role(this, "DlmRole", {
      roleName: names.dlmRole(stage),
      assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
      permissionsBoundary: boundary,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole")],
      description: `memory-anywhere ${stage} daily EBS snapshots`,
    });

    // Key policy statements beyond the account-root default (§3.6). The backup
    // bucket ARN is spelled out: referencing the bucket would make the key depend
    // on the bucket that is encrypted with it.
    const backupArn = `arn:${Aws.PARTITION}:s3:::${bucketName("backup", account, region, stage)}`;
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "InstanceRoleViaS3OnBackupBucket",
        principals: [new iam.ArnPrincipal(instanceRole.roleArn)],
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` },
          StringLike: { "kms:EncryptionContext:aws:s3:arn": [backupArn, `${backupArn}/*`] },
        },
      }),
    );
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "EbsGrantsForLaunchAndSnapshots",
        principals: [new iam.ArnPrincipal(cfnExecRoleArn), new iam.ArnPrincipal(dlmRole.roleArn)],
        actions: ["kms:CreateGrant"],
        resources: ["*"],
        conditions: { Bool: { "kms:GrantIsForAWSResource": "true" }, StringEquals: { "kms:ViaService": `ec2.${region}.amazonaws.com` } },
      }),
    );
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "EbsUseForLaunchAndSnapshots",
        principals: [new iam.ArnPrincipal(cfnExecRoleArn), new iam.ArnPrincipal(dlmRole.roleArn)],
        actions: ["kms:GenerateDataKeyWithoutPlaintext", "kms:Decrypt", "kms:DescribeKey", "kms:ReEncrypt*"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ec2.${region}.amazonaws.com` } },
      }),
    );
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OperatorRestoreViaS3",
        principals: [new iam.AccountRootPrincipal()],
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` },
          ArnLike: { "aws:PrincipalArn": operatorRoleArnPattern },
        },
      }),
    );

    // ---- Backup bucket policy (§5.2) ----
    const backupResources = [backupBucket.bucketArn, backupBucket.arnForObjects("*")];
    const always = [instanceRole.roleArn, operatorRoleArnPattern, cfnExecRoleArn, accountRootArn];
    const destroyActions = ["s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion"];
    if (isProd) {
      backupBucket.addToResourcePolicy(denyUnlessPrincipal("OnlyStackPrincipals", ["s3:*"], backupResources, always));
    } else {
      backupBucket.addToResourcePolicy(denyUnlessPrincipal("OnlyStackPrincipals", destroyActions, backupResources, always, true));
      backupBucket.addToResourcePolicy(denyUnlessPrincipal("DeployMayOnlyEmptyNonProd", destroyActions, backupResources, [...always, deployRoleArnPattern]));
    }
    backupBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "InstanceOnlyThroughTheGatewayEndpoint",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:*"],
        resources: backupResources,
        conditions: { ArnEquals: { "aws:PrincipalArn": instanceRole.roleArn }, StringNotEquals: { "aws:SourceVpce": s3Endpoint.vpcEndpointId } },
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
        [accountRootArn, cfnExecRoleArn],
      ),
    );
    if (isProd) {
      backupBucket.addToResourcePolicy(
        denyUnlessPrincipal("ProdVersionsOnlyRoot", ["s3:DeleteObjectVersion", "s3:DeleteBucket"], backupResources, [accountRootArn]),
      );
    }
    backupBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "PutOnlyWithTheStackKey",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [backupBucket.arnForObjects("*")],
        conditions: { StringNotEquals: { "s3:x-amz-server-side-encryption-aws-kms-key-id": key.keyArn } },
      }),
    );
    backupBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "PutOnlySseKms",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [backupBucket.arnForObjects("*")],
        conditions: { StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" } },
      }),
    );

    // ---- Instance ----
    const profile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      instanceProfileName: names.instanceProfile(stage),
      roles: [instanceRole.roleName],
    });
    const stageTags = [{ key: TAG_STAGE, value: stage }];
    const userData = buildUserData({
      stage,
      prefix,
      region,
      host: host.valueAsString,
      alertEmail: alertEmail.valueAsString,
      releasesBucket: releasesBucket.bucketName,
      backupBucket: backupBucket.bucketName,
      keyArn: key.keyArn,
      topicArn: topic.topicArn,
      logGroup: logGroup.logGroupName,
      releaseKeys: props.releaseKeys,
      pins: props.pins,
      files: props.hostFiles,
    });
    const launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: names.launchTemplate(stage),
      launchTemplateData: {
        imageId: props.amiId,
        instanceType: "t4g.small",
        creditSpecification: { cpuCredits: "standard" },
        iamInstanceProfile: { arn: profile.attrArn },
        metadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 1, httpEndpoint: "enabled", instanceMetadataTags: "disabled" },
        monitoring: { enabled: false },
        blockDeviceMappings: [
          { deviceName: "/dev/xvda", ebs: { volumeType: "gp3", volumeSize: 20, encrypted: true, kmsKeyId: key.keyArn, deleteOnTermination: true } },
        ],
        tagSpecifications: [
          { resourceType: "instance", tags: [...stageTags, { key: "Name", value: `memory-anywhere-${stage}` }] },
          { resourceType: "volume", tags: [...stageTags, { key: "Name", value: `memory-anywhere-${stage}-root` }] },
        ],
        userData,
      },
    });
    const [subnet] = vpc.publicSubnets;
    if (!subnet) throw new Error("the VPC has no public subnet");
    const instance = new ec2.CfnInstance(this, "Instance", {
      launchTemplate: { launchTemplateId: launchTemplate.ref, version: launchTemplate.attrLatestVersionNumber },
      subnetId: subnet.subnetId,
      securityGroupIds: [sg.securityGroupId],
    });
    const eip = new ec2.CfnEIP(this, "ElasticIp", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "ElasticIpAssociation", { allocationId: eip.attrAllocationId, instanceId: instance.ref });

    // ---- Snapshots ----
    new dlm.CfnLifecyclePolicy(this, "DailySnapshots", {
      // DLM allows only [0-9A-Za-z _-] here.
      description: `memory-anywhere ${stage} root volume daily 0500 UTC keep 7`,
      state: "ENABLED",
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        policyType: "EBS_SNAPSHOT_MANAGEMENT",
        resourceTypes: ["VOLUME"],
        targetTags: stageTags.map((t) => ({ key: t.key, value: t.value })),
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

    // ---- Logs, metric filters, alarms ----
    const namespace = `memory-anywhere/${stage}`;
    const filters: { name: string; pattern: logs.IFilterPattern; threshold: number; minutes: number }[] = [
      { name: "ma_5xx", pattern: logs.FilterPattern.numberValue("$.status", ">=", 500), threshold: 5, minutes: 5 },
      { name: "ma_auth_fail", pattern: logs.FilterPattern.stringValue("$.reason", "=", "auth_fail"), threshold: 5, minutes: 10 },
      { name: "ma_backup_lag", pattern: logs.FilterPattern.stringValue("$.reason", "=", "backup_lag"), threshold: 1, minutes: 5 },
    ];
    const alarmAction = new cwActions.SnsAction(topic);
    for (const f of filters) {
      const metric = new logs.MetricFilter(this, `Filter_${f.name}`, {
        logGroup,
        filterName: f.name,
        filterPattern: f.pattern,
        metricNamespace: namespace,
        metricName: f.name,
        metricValue: "1",
        defaultValue: 0,
      }).metric({ statistic: "Sum", period: Duration.minutes(f.minutes) });
      new cloudwatch.Alarm(this, `Alarm_${f.name}`, {
        alarmName: names.alarm(stage, f.name),
        metric,
        threshold: f.threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);
    }
    new cloudwatch.Alarm(this, "Alarm_status_check", {
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

    // ---- Cost: budget and anomaly monitor ----
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: names.budget(stage),
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 30, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 25, thresholdType: "ABSOLUTE_VALUE" },
          subscribers: [{ subscriptionType: "SNS", address: topic.topicArn }],
        },
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 30, thresholdType: "ABSOLUTE_VALUE" },
          subscribers: [{ subscriptionType: "SNS", address: topic.topicArn }],
        },
      ],
    });
    const monitor = new ce.CfnAnomalyMonitor(this, "AnomalyMonitor", {
      monitorName: names.anomalyMonitor(stage),
      monitorType: "DIMENSIONAL",
      monitorDimension: "SERVICE",
    });
    new ce.CfnAnomalySubscription(this, "AnomalySubscription", {
      subscriptionName: names.anomalyMonitor(stage),
      // SNS subscribers require IMMEDIATE (Cost Anomaly Detection API); spec-issues.md #7.
      frequency: "IMMEDIATE",
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: "SNS", address: topic.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["5"] },
      }),
    });

    // ---- Topic policy: who may publish ----
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
    // Cost Anomaly Detection validates the topic against AWS's documented policy,
    // which has no source condition; a mismatch would roll back the whole stack.
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CostAnomalyDetection",
        principals: [new iam.ServicePrincipal("costalerts.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
      }),
    );

    // ---- CloudTrail and EventBridge (§2) ----
    const trail = new cloudtrail.Trail(this, "Trail", {
      trailName: names.trail(stage),
      bucket: trailBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false,
    });
    trail.addS3EventSelector([{ bucket: releasesBucket }], { readWriteType: cloudtrail.ReadWriteType.WRITE_ONLY, includeManagementEvents: true });

    const apiCall = "AWS API Call via CloudTrail";
    const own = (what: string) => `*${what}*`;
    const rules: { name: string; pattern: events.EventPattern }[] = [
      {
        name: "kms-key-changes",
        pattern: { source: ["aws.kms"], detailType: [apiCall], detail: { eventName: ["ScheduleKeyDeletion", "DisableKey", "PutKeyPolicy"] } },
      },
      {
        name: "bucket-controls",
        pattern: {
          source: ["aws.s3"],
          detailType: [apiCall],
          detail: {
            eventName: ["PutBucketPolicy", "DeleteBucketPolicy", "PutBucketVersioning", "PutBucketLifecycle", "PutBucketLifecycleConfiguration"],
          },
        },
      },
      {
        name: "iam-changes",
        pattern: {
          source: ["aws.iam"],
          detailType: [apiCall],
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
        pattern: { source: ["aws.signin"], detailType: ["AWS Console Sign In via CloudTrail"], detail: { userIdentity: { type: ["Root", "IAMUser"] } } },
      },
      {
        name: "stack-changes",
        pattern: {
          source: ["aws.cloudformation"],
          detailType: [apiCall],
          detail: {
            eventName: ["CreateStack", "UpdateStack", "ExecuteChangeSet", "DeleteStack"],
            requestParameters: { stackName: [{ wildcard: own(stackName(stage)) }] },
          },
        },
      },
      {
        name: "instance-changes",
        pattern: {
          source: ["aws.ec2"],
          detailType: [apiCall],
          detail: { eventName: ["ModifyInstanceAttribute", "RunInstances", "TerminateInstances"] },
        },
      },
      {
        name: "release-and-key-parameters",
        pattern: {
          source: ["aws.ssm"],
          detailType: [apiCall],
          detail: {
            eventName: ["PutParameter"],
            requestParameters: { name: [`${prefix}/release/desired`, { prefix: `${prefix}/llm/` }] },
          },
        },
      },
      {
        name: "sessions-and-commands",
        pattern: { source: ["aws.ssm"], detailType: [apiCall], detail: { eventName: ["SendCommand", "StartSession"] } },
      },
      {
        name: "release-uploads",
        pattern: {
          source: ["aws.s3"],
          detailType: [apiCall],
          detail: { eventName: ["PutObject"], requestParameters: { bucketName: [releasesBucket.bucketName] } },
        },
      },
    ];
    for (const r of rules) {
      new events.CfnRule(this, `Rule_${r.name}`, {
        name: names.rule(stage, r.name),
        state: "ENABLED",
        eventPattern: renderPattern(r.pattern),
        targets: [{ id: "alerts", arn: topic.topicArn }],
      });
    }

    // ---- Outputs read by mema deploy / destroy and ma-operator.sh ----
    new CfnOutput(this, "ElasticIpOut", { key: "ElasticIp", value: eip.ref });
    new CfnOutput(this, "InstanceIdOut", { key: "InstanceId", value: instance.ref });
    new CfnOutput(this, "BackupBucketOut", { key: "BackupBucket", value: backupBucket.bucketName });
    new CfnOutput(this, "ReleasesBucketOut", { key: "ReleasesBucket", value: releasesBucket.bucketName });
    new CfnOutput(this, "TrailBucketOut", { key: "TrailBucket", value: trailBucket.bucketName });
    new CfnOutput(this, "KeyArnOut", { key: "KeyArn", value: key.keyArn });
    new CfnOutput(this, "AlertsTopicOut", { key: "AlertsTopic", value: topic.topicArn });
    new CfnOutput(this, "ParameterPrefixOut", { key: "ParameterPrefix", value: prefix });
    new CfnOutput(this, "StageOut", { key: "Stage", value: stage });
    // The origin of the stage's admin and setup pages (spike serves everything on one name, §9).
    const adminHost = stage === "prod" ? `admin.${host.valueAsString}` : stage === "spike" ? `spike.${host.valueAsString}` : `admin.eval.${host.valueAsString}`;
    new CfnOutput(this, "AdminOriginOut", { key: "AdminOrigin", value: `https://${adminHost}` });
  }
}

/** Deny `actions` on `resources` to every principal whose ARN is not in `allowed`.
 * With `notAction`, the deny covers every action except `actions`. */
function denyUnlessPrincipal(sid: string, actions: string[], resources: string[], allowed: string[], notAction = false): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    ...(notAction ? { notActions: actions } : { actions }),
    resources,
    conditions: { ArnNotLike: { "aws:PrincipalArn": allowed } },
  });
}

/** CloudFormation wants the raw EventBridge pattern (detail-type, not detailType). */
function renderPattern(p: events.EventPattern): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.source) out["source"] = p.source;
  if (p.detailType) out["detail-type"] = p.detailType;
  if (p.detail) out["detail"] = p.detail;
  return out;
}
