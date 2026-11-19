// The memory-anywhere stack (deployment-aws.md §2, §3.5, §3.6, §5.2, §9), built from the parts in
// ./stack/ in the order they depend on each other. Every part adds its constructs to this stack
// directly, so each keeps its CloudFormation logical id: a changed id would replace the resource.
//
// The owner's hostname and alert email are CloudFormation parameters, so the
// synthesized template (and anything committed) never contains them. The stack
// uses no Lambda-backed custom resources: everything here is a plain
// CloudFormation resource that the cfn-exec policies in ../iam/ allow.

import { CfnOutput, CfnParameter, DefaultStackSynthesizer, Stack, Tags, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { TAG_STAGE, stackName, stageHost, type Stage } from "./names.ts";
import { alarms, alertsTopic, costWatch, topicPublishers } from "./stack/alerts.ts";
import { audit } from "./stack/audit.ts";
import { stackContext } from "./stack/context.ts";
import { instanceAccess, server } from "./stack/instance.ts";
import { network } from "./stack/network.ts";
import { protectBackups, storage } from "./stack/storage.ts";
import type { HostFile, ReleaseKey } from "./user-data.ts";

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
	/** Raised to build a new instance (inputs.ts); 0 keeps the original launch template. */
	instanceGeneration: number;
}

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
		Tags.of(this).add(TAG_STAGE, stage);

		const host = new CfnParameter(this, "Host", {
			type: "String",
			description:
				"The owner's subdomain ({host}); the stage serves " +
				(stage === "prod" ? "{host} and admin.{host}" : stageHost(stage, "{host}")),
			allowedPattern: "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
			constraintDescription: "a lowercase DNS name (the owner's subdomain)",
		});
		const alertEmail = new CfnParameter(this, "AlertEmail", {
			type: "String",
			description: "Address for SNS alerts and the ACME account",
			allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
			constraintDescription: "an email address",
		});
		const ownerTimezone = new CfnParameter(this, "OwnerTimezone", {
			type: "String",
			description: "The owner's IANA time zone: the daily digest and the nightly maintenance run in owner local time",
			default: "UTC",
			allowedPattern: "^[A-Za-z][A-Za-z0-9_+\\-]*(/[A-Za-z0-9_+\\-]+){0,2}$",
			constraintDescription: "an IANA time zone such as Europe/Berlin",
		});

		const c = stackContext(this, stage);
		const net = network(c);
		const store = storage(c);
		const topic = alertsTopic(c, alertEmail);
		const access = instanceAccess(c, store, topic);
		protectBackups(c, store, { ...access, s3Endpoint: net.s3Endpoint });
		const { instance, eip } = server(c, { ...props, host, alertEmail, ownerTimezone }, net, store, access, topic);
		alarms(c, topic, access.logGroup, instance);
		costWatch(c, topic);
		topicPublishers(c, topic, access.instanceRole);
		audit(c, store.trailBucket, store.releasesBucket, topic);

		// ---- Outputs read by mema deploy / destroy and ma-operator.sh ----
		const output = (id: string, value: string) => new CfnOutput(this, `${id}Out`, { key: id, value });
		output("ElasticIp", eip.ref);
		output("InstanceId", instance.ref);
		output("BackupBucket", store.backupBucket.bucketName);
		output("ReleasesBucket", store.releasesBucket.bucketName);
		output("TrailBucket", store.trailBucket.bucketName);
		output("ManifestBucket", store.manifestBucket.bucketName);
		// Read back by `mema deploy aws --update`, which passes it again so an update keeps the instance.
		output("InstanceGeneration", String(props.instanceGeneration));
		output("KeyArn", store.key.keyArn);
		output("AlertsTopic", topic.topicArn);
		output("ParameterPrefix", c.prefix);
		output("Stage", stage);
		// The origin of the stage's admin and setup pages (spike serves everything on one name, §9).
		const adminHost =
			stage === "prod"
				? `admin.${host.valueAsString}`
				: stage === "spike"
					? `spike.${host.valueAsString}`
					: `admin.eval.${host.valueAsString}`;
		output("AdminOrigin", `https://${adminHost}`);
	}
}
