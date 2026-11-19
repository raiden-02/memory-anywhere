// What every part of the stack needs: the stack itself as the scope (so every construct keeps the
// logical id it had when the stack was one constructor), the stage, and the principals that
// resource policies name.

import { Aws, RemovalPolicy, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { BOUNDARY_POLICY, names, parameterPrefix, type Stage } from "../names.ts";

const SSO_OPERATOR_ROLE = "AWSReservedSSO_memory-anywhere-operator_*";
const SSO_DEPLOY_ROLE = "AWSReservedSSO_memory-anywhere-deploy_*";

export interface StackContext {
	readonly scope: Stack;
	readonly stage: Stage;
	readonly isProd: boolean;
	/** Prod keeps its data when the stack is deleted; other stages remove it. */
	readonly removal: RemovalPolicy;
	readonly account: string;
	readonly region: string;
	/** The stage's SSM parameter path. */
	readonly prefix: string;
	readonly principals: Principals;
}

export interface Principals {
	readonly accountRootArn: string;
	/** The role CloudFormation runs as (../iam/). */
	readonly cfnExecRoleArn: string;
	/** The owner's Identity Center roles, matched by pattern: their names carry a random suffix. */
	readonly operatorRoleArnPattern: string;
	readonly deployRoleArnPattern: string;
	/** Every role the stack creates is bounded by this policy. */
	readonly boundary: iam.IManagedPolicy;
}

export function stackContext(scope: Stack, stage: Stage): StackContext {
	const isProd = stage === "prod";
	const account = Aws.ACCOUNT_ID;
	const region = Aws.REGION;
	const role = (path: string) => `arn:${Aws.PARTITION}:iam::${account}:role/${path}`;
	return {
		scope,
		stage,
		isProd,
		removal: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
		account,
		region,
		prefix: parameterPrefix(stage),
		principals: {
			accountRootArn: `arn:${Aws.PARTITION}:iam::${account}:root`,
			cfnExecRoleArn: role(names.cfnExecRole(account, region)),
			operatorRoleArnPattern: role(`aws-reserved/sso.amazonaws.com/*${SSO_OPERATOR_ROLE}`),
			deployRoleArnPattern: role(`aws-reserved/sso.amazonaws.com/*${SSO_DEPLOY_ROLE}`),
			boundary: iam.ManagedPolicy.fromManagedPolicyName(scope, "Boundary", BOUNDARY_POLICY),
		},
	};
}

/** Deny `actions` on `resources` to every principal whose ARN is not in `allowed`.
 * With `notAction`, the deny covers every action except `actions`. */
export function denyUnlessPrincipal(
	sid: string,
	actions: string[],
	resources: string[],
	allowed: string[],
	notAction = false,
): iam.PolicyStatement {
	return new iam.PolicyStatement({
		sid,
		effect: iam.Effect.DENY,
		principals: [new iam.AnyPrincipal()],
		...(notAction ? { notActions: actions } : { actions }),
		resources,
		conditions: { ArnNotLike: { "aws:PrincipalArn": allowed } },
	});
}
