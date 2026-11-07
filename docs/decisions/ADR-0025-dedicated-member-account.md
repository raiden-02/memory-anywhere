# 0025 A dedicated member account for memory-anywhere

Status: accepted
Date: 2026-11-07

## Context
The owner's existing AWS account already hosts his portfolio website. Permission sets exist only in an organization instance of IAM Identity Center (account instances cannot grant account access), and each Identity Center user needs its own email (round-4 recheck R4-B1).

## Options
1. Single account: enable Organizations, and assign the permission sets to the existing (management) account itself. Works, but the deploy and operator roles then live next to the portfolio, and the bill and any mistake are shared.
2. Dedicated member account `memory-anywhere`: the existing account becomes the management account and keeps Identity Center; the permission sets are assigned only in the member account.

## Decision
Option 2 is the owner default. No serious reason against it was found: Organizations, the organization instance of Identity Center and member accounts cost nothing; the existing workloads are not changed (no service control policies are added); the member account's root user can stay without a password and is used only for break-glass through password recovery on its plus-addressed email. Two points are checked in M0: that Budgets and Cost Anomaly Detection work inside the member account (Q27, with a management-account fallback), and that `ma-deploy` sees only the member account (Q25). Option 1 is documented for self-hosters with nothing else in their account, and works with the same scripts given that account's id. Exact steps: deployment-aws.md §3.1–§3.3.

## Consequences
The bootstrap has two scripts: one in the member account (policies, CDK bootstrap, IMDS defaults) and one in the management account (permission sets and assignments, removal of the temporary `AdministratorAccess` assignment). The owner needs three plus-addressed emails (member account, two users).
