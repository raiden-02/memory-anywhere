#!/usr/bin/env bash
# One-time bootstrap of the memory-anywhere MEMBER account (deployment-aws.md §3.3 step 2).
#
# Run in AWS CloudShell of the memory-anywhere member account, signed in as
# ma-operator with the temporary AdministratorAccess assignment, from the commit
# the owner reviewed:
#
#   bash deploy/aws/bootstrap-member.sh <member account id> <region>
#
# It creates (or updates) the customer managed policies memory-anywhere-cfn-exec,
# memory-anywhere-cfn-exec-services and memory-anywhere-boundary, bootstraps CDK
# with those execution policies, requires IMDSv2 by account default, and turns
# on account-level S3 Block Public Access. Safe to re-run.

set -euo pipefail

readonly CDK_VERSION="2.1148.0" # aws-cdk CLI, pinned (config-and-cli.md §2)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE

die() { echo "error: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: bash deploy/aws/bootstrap-member.sh <member account id> <region>"
readonly ACCOUNT_ID="$1" REGION="$2"
[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "member account id must be 12 digits"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "region looks wrong: $REGION"

caller_account="$(aws sts get-caller-identity --query Account --output text)"
caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
[ "$caller_account" = "$ACCOUNT_ID" ] || die "signed in to account $caller_account, not the member account $ACCOUNT_ID"

cat <<EOF
memory-anywhere member-account bootstrap
  account : $ACCOUNT_ID
  region  : $REGION
  caller  : $caller_arn
  commit  : $(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo "unknown (not a git checkout)")
It will create or update 3 IAM policies, run 'cdk bootstrap' (aws-cdk@$CDK_VERSION),
set the account IMDS default to IMDSv2 with hop limit 1, and enable account-level
S3 Block Public Access.
EOF
read -r -p "Type yes to continue: " answer
[ "$answer" = "yes" ] || die "aborted"

# Fill the two placeholders; any other ${...} (IAM policy variables) stays intact.
render() { sed -e "s/\${ACCOUNT_ID}/$ACCOUNT_ID/g" -e "s/\${REGION}/$REGION/g" "$1"; }

upsert_policy() {
  local name="$1" file="$2" description="$3"
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/${name}"
  local doc
  doc="$(render "$file")"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    # IAM keeps at most 5 versions; drop the oldest non-default one first.
    local old
    # shellcheck disable=SC2016 # the backticks are a JMESPath literal, not shell
    old="$(aws iam list-policy-versions --policy-arn "$arn" \
      --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[].VersionId' --output text)"
    if [ "$(wc -w <<<"$old")" -ge 4 ]; then
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$(awk '{print $1}' <<<"$old")"
    fi
    aws iam create-policy-version --policy-arn "$arn" --policy-document "$doc" --set-as-default >/dev/null
    echo "updated policy $name"
  else
    aws iam create-policy --policy-name "$name" --policy-document "$doc" --description "$description" \
      --tags Key=memory-anywhere:stage,Value=bootstrap >/dev/null
    echo "created policy $name"
  fi
}

upsert_policy memory-anywhere-boundary "$HERE/iam/boundary.json" \
  "Caps every role the memory-anywhere stacks create (deployment-aws.md 3.3)"
upsert_policy memory-anywhere-cfn-exec "$HERE/iam/cfn-exec.json" \
  "CDK CloudFormation execution policy, EC2/IAM/KMS part (deployment-aws.md 3.3)"
upsert_policy memory-anywhere-cfn-exec-services "$HERE/iam/cfn-exec-services.json" \
  "CDK CloudFormation execution policy, other services (deployment-aws.md 3.3)"

npx --yes "aws-cdk@${CDK_VERSION}" bootstrap "aws://${ACCOUNT_ID}/${REGION}" \
  --cloudformation-execution-policies \
  "arn:aws:iam::${ACCOUNT_ID}:policy/memory-anywhere-cfn-exec,arn:aws:iam::${ACCOUNT_ID}:policy/memory-anywhere-cfn-exec-services"

aws ec2 modify-instance-metadata-defaults --http-tokens required --http-put-response-hop-limit 1 --region "$REGION" >/dev/null

aws s3control put-public-access-block --account-id "$ACCOUNT_ID" --region "$REGION" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo
echo "== verification =="
echo "CDK execution policies:"
aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='CloudFormationExecutionPolicies'].ParameterValue" --output text
echo "IMDS account defaults:"
aws ec2 get-instance-metadata-defaults --region "$REGION" --query AccountLevel --output json
echo "Account Block Public Access:"
aws s3control get-public-access-block --account-id "$ACCOUNT_ID" --region "$REGION" --output json
echo "Done. Next: bootstrap-identity.sh in the management account (deployment-aws.md §3.3 step 3)."
