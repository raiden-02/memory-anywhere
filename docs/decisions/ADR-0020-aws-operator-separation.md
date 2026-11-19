# 0020 AWS deploy/operator separation: two Identity Center users, operator only in CloudShell

Status: accepted
Date: 2026-11-07

## Context
v3 put two permission sets on one Identity Center user and two profiles on the PC. The AWS CLI caches the SSO token per `sso-session` and refreshes role credentials for the whole access-portal session, so an agent shell that reads the cache can mint operator credentials and take over the store through `reset-owner` (round-3 audit B3).

## Options
1. Separate `sso-session` blocks per profile on the same OS account: still one cache readable by the agent.
2. Separate OS account for operator work: real, but a second Windows login for one person.
3. Operator path through a fresh passkey on the server instead of AWS rights: covers some tasks, but setup and break-glass happen exactly when passkeys are absent.
4. Two Identity Center users; the operator user signs in only in a private browser window and works in AWS CloudShell; the PC holds only the deploy profile.

## Decision
Option 4: the easiest real separation for one person (one extra browser sign-in, no second OS account). Both users live in the organization instance of Identity Center in the management account, have different (plus-addressed) emails, and are assigned only in the dedicated `memory-anywhere` member account (ADR-0025). The operator set includes the CloudShell actions it needs. The deploy session is signed out by `mema deploy` on exit and the portal session lasts 1 hour. `reset-owner` waits 24 hours and emails the owner, who can cancel with a passkey. Every deploy-path API call is alerted. Exact config: deployment-aws.md §3.

## Consequences
Operator tasks (setup link, LLM key, restore, reset, data deletion) need the browser and CloudShell, not the PC. A hijacked agent during a live deploy session can still change the stack (accepted residual, alerted). M0 Q25 must show the separation holds.
