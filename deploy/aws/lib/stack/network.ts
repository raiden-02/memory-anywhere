// The network: one public subnet, no NAT, a gateway endpoint so S3 traffic stays inside AWS, and a
// security group that lets in only HTTPS.

import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { StackContext } from "./context.ts";

export interface Network {
	readonly vpc: ec2.Vpc;
	readonly subnet: ec2.ISubnet;
	readonly s3Endpoint: ec2.GatewayVpcEndpoint;
	readonly securityGroup: ec2.SecurityGroup;
}

export function network({ scope }: StackContext): Network {
	const vpc = new ec2.Vpc(scope, "Vpc", {
		ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/24"),
		maxAzs: 1,
		natGateways: 0,
		subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 }],
		restrictDefaultSecurityGroup: false, // would add a Lambda-backed custom resource
	});
	const s3Endpoint = vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

	const securityGroup = new ec2.SecurityGroup(scope, "InstanceSg", {
		vpc,
		description: "memory-anywhere: 443 in; 443 and NTP out",
		allowAllOutbound: false,
		allowAllIpv6Outbound: false,
	});
	securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
	securityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), "HTTPS");
	securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS (AWS APIs, releases, ACME, DoH)");
	securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(123), "NTP");

	const [subnet] = vpc.publicSubnets;
	if (!subnet) throw new Error("the VPC has no public subnet");
	return { vpc, subnet, s3Endpoint, securityGroup };
}
