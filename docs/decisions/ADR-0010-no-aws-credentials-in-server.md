# 0010 The server process holds no AWS credentials

Status: accepted
Date: 2026-11-07

## Context
SSRF from CIMD fetches or future features could reach IMDS and the instance role, which can read backups (review2-security W1, W5, W6). The architecture review put the LLM key in SSM read by the instance role and allowed Bedrock (N9).

## Decision
IMDS is blocked by iptables for the server and Caddy users. A oneshot service under its own user reads SSM parameters into a tmpfs file at boot, and an outbox helper under the same user sends what the server must send (the setup token to SSM, alert emails to SNS, and from M4 the daily manifests to S3). Litestream runs as its own user with the role. Bedrock is not supported in v1, because it would need role credentials in the server. Spec: deployment-aws.md §4.

## Consequences
Changing the LLM key needs a service restart. Bedrock can be added later as a separate process.
