#!/usr/bin/env bash
# One-time Identity Center bootstrap in the MANAGEMENT account (deployment-aws.md §3.3 step 3).
#
# Run in AWS CloudShell of the management account (root or an existing
# administrator), from the commit the owner reviewed, after bootstrap-member.sh:
#
#   bash deploy/aws/bootstrap-identity.sh <member account id> <identity-center region>
#
# It creates or updates the permission sets memory-anywhere-deploy and
# memory-anywhere-operator (1-hour sessions, inline policies from iam/*.json,
# no permissions boundary), assigns them to ma-deploy and ma-operator on the
# member account only, removes the temporary AdministratorAccess assignment,
# and prints the member account's assignments, which must be exactly those two.
# Every sso-admin and identitystore call goes to the Identity Center region.
# Safe to re-run.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
die() { echo "error: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: bash deploy/aws/bootstrap-identity.sh <member account id> <identity-center region>"
readonly MEMBER="$1" IC_REGION="$2"
[[ "$MEMBER" =~ ^[0-9]{12}$ ]] || die "member account id must be 12 digits"
[[ "$IC_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "Identity Center region looks wrong: $IC_REGION"

sso() { aws sso-admin --region "$IC_REGION" "$@"; }
ids() { aws identitystore --region "$IC_REGION" "$@"; }

caller="$(aws sts get-caller-identity --query Account --output text)"
mgmt="$(aws organizations describe-organization --query Organization.MasterAccountId --output text)"
[ "$caller" = "$mgmt" ] || die "run this in the management account ($mgmt), not $caller"
member_name="$(aws organizations describe-account --account-id "$MEMBER" --query Account.Name --output text)"

instance_count="$(sso list-instances --query 'length(Instances)' --output text)"
[ "$instance_count" = "1" ] || die "expected exactly one Identity Center instance in $IC_REGION, found $instance_count"
INSTANCE="$(sso list-instances --query 'Instances[0].InstanceArn' --output text)"
STORE="$(sso list-instances --query 'Instances[0].IdentityStoreId' --output text)"
owner="$(sso describe-instance --instance-arn "$INSTANCE" --query OwnerAccountId --output text)"

cat <<EOF
memory-anywhere Identity Center bootstrap
  Identity Center region : $IC_REGION
  instance ARN           : $INSTANCE
  instance owner account : $owner (management account: $mgmt)
  member account         : $MEMBER ($member_name)
  commit                 : $(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo "unknown (not a git checkout)")
EOF
[ "$owner" = "$mgmt" ] || die "this is not the organization instance (owner $owner); delete any account instance first"
read -r -p "Type yes to continue: " answer
[ "$answer" = "yes" ] || die "aborted"

user_id() {
  ids get-user-id --identity-store-id "$STORE" --output text --query UserId \
    --alternate-identifier "{\"UniqueAttribute\":{\"AttributePath\":\"userName\",\"AttributeValue\":\"$1\"}}" \
    || die "Identity Center user $1 not found (DESIGN.md §9.1 step 3.4)"
}

permission_set_arn() { # name -> ARN or empty
  local arn
  for arn in $(sso list-permission-sets --instance-arn "$INSTANCE" --query 'PermissionSets[]' --output text); do
    if [ "$(sso describe-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" \
      --query PermissionSet.Name --output text)" = "$1" ]; then
      echo "$arn"; return
    fi
  done
}

wait_for() { # operation kind, request id
  local kind="$1" id="$2" status
  for _ in $(seq 1 60); do
    case "$kind" in
      provision) status="$(sso describe-permission-set-provisioning-status --instance-arn "$INSTANCE" \
        --provision-permission-set-request-id "$id" --query PermissionSetProvisioningStatus.Status --output text)" ;;
      create) status="$(sso describe-account-assignment-creation-status --instance-arn "$INSTANCE" \
        --account-assignment-creation-request-id "$id" --query AccountAssignmentCreationStatus.Status --output text)" ;;
      delete) status="$(sso describe-account-assignment-deletion-status --instance-arn "$INSTANCE" \
        --account-assignment-deletion-request-id "$id" --query AccountAssignmentDeletionStatus.Status --output text)" ;;
    esac
    case "$status" in
      SUCCEEDED) return 0 ;;
      FAILED) die "$kind request $id failed" ;;
    esac
    sleep 2
  done
  die "$kind request $id did not finish"
}

upsert_permission_set() { # name, policy file, description -> ARN
  local name="$1" file="$2" description="$3" arn
  arn="$(permission_set_arn "$name")"
  if [ -z "$arn" ]; then
    arn="$(sso create-permission-set --instance-arn "$INSTANCE" --name "$name" --description "$description" \
      --session-duration PT1H --query PermissionSet.PermissionSetArn --output text)"
    echo "created permission set $name" >&2
  else
    sso update-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" \
      --session-duration PT1H --description "$description" >/dev/null
    echo "updated permission set $name" >&2
  fi
  # Only ${ACCOUNT_ID} is filled; IAM policy variables such as ${aws:userid} stay.
  sso put-inline-policy-to-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" \
    --inline-policy "$(sed -e "s/\${ACCOUNT_ID}/$MEMBER/g" "$file")" >/dev/null
  # No boundary (it would intersect away the set's own rights, R5-B1) and no managed policies.
  if sso get-permissions-boundary-for-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" >/dev/null 2>&1; then
    sso delete-permissions-boundary-from-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" >/dev/null
  fi
  [ "$(sso list-managed-policies-in-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" \
    --query 'length(AttachedManagedPolicies)' --output text)" = "0" ] || die "$name has managed policies attached; remove them first"
  [ "$(sso list-customer-managed-policy-references-in-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$arn" \
    --query 'length(CustomerManagedPolicyReferences)' --output text)" = "0" ] || die "$name has customer managed policies attached; remove them first"
  echo "$arn"
}

assign() { # permission set ARN, user id
  local ps="$1" uid="$2" existing id
  existing="$(sso list-account-assignments --instance-arn "$INSTANCE" --account-id "$MEMBER" --permission-set-arn "$ps" \
    --query "length(AccountAssignments[?PrincipalId=='$uid'])" --output text)"
  [ "$existing" = "0" ] || return 0
  id="$(sso create-account-assignment --instance-arn "$INSTANCE" --target-id "$MEMBER" --target-type AWS_ACCOUNT \
    --permission-set-arn "$ps" --principal-type USER --principal-id "$uid" \
    --query AccountAssignmentCreationStatus.RequestId --output text)"
  wait_for create "$id"
}

provision() { # permission set ARN
  local id
  id="$(sso provision-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$1" \
    --target-type AWS_ACCOUNT --target-id "$MEMBER" --query PermissionSetProvisioningStatus.RequestId --output text)"
  wait_for provision "$id"
}

DEPLOY_USER="$(user_id ma-deploy)"
OPERATOR_USER="$(user_id ma-operator)"

DEPLOY_SET="$(upsert_permission_set memory-anywhere-deploy "$HERE/iam/deploy-permission-set.json" \
  "memory-anywhere deploys from the owner's PC (deployment-aws.md 3.4)")"
OPERATOR_SET="$(upsert_permission_set memory-anywhere-operator "$HERE/iam/operator-permission-set.json" \
  "memory-anywhere operator tasks in CloudShell only (deployment-aws.md 3.4)")"

assign "$DEPLOY_SET" "$DEPLOY_USER"
assign "$OPERATOR_SET" "$OPERATOR_USER"
provision "$DEPLOY_SET"
provision "$OPERATOR_SET"

ADMIN_SET="$(permission_set_arn AdministratorAccess)"
if [ -n "$ADMIN_SET" ]; then
  for uid in $(sso list-account-assignments --instance-arn "$INSTANCE" --account-id "$MEMBER" --permission-set-arn "$ADMIN_SET" \
    --query "AccountAssignments[?PrincipalType=='USER'].PrincipalId" --output text); do
    id="$(sso delete-account-assignment --instance-arn "$INSTANCE" --target-id "$MEMBER" --target-type AWS_ACCOUNT \
      --permission-set-arn "$ADMIN_SET" --principal-type USER --principal-id "$uid" \
      --query AccountAssignmentDeletionStatus.RequestId --output text)"
    wait_for delete "$id"
    echo "removed AdministratorAccess from user $uid on $MEMBER"
  done
fi

echo
echo "== assignments on account $MEMBER =="
found=""
for ps in $(sso list-permission-sets-provisioned-to-account --instance-arn "$INSTANCE" --account-id "$MEMBER" \
  --query 'PermissionSets[]' --output text); do
  ps_name="$(sso describe-permission-set --instance-arn "$INSTANCE" --permission-set-arn "$ps" --query PermissionSet.Name --output text)"
  for row in $(sso list-account-assignments --instance-arn "$INSTANCE" --account-id "$MEMBER" --permission-set-arn "$ps" \
    --query 'AccountAssignments[].[PrincipalType,PrincipalId]' --output text | tr '\t' ':'); do
    principal="${row#*:}"
    label="$principal"
    [ "${row%%:*}" = "USER" ] && label="$(ids describe-user --identity-store-id "$STORE" --user-id "$principal" --query UserName --output text)"
    echo "  $ps_name -> ${row%%:*} $label"
    found="$found $ps_name=$label"
  done
done
expected=" memory-anywhere-deploy=ma-deploy memory-anywhere-operator=ma-operator"
if [ "$(tr ' ' '\n' <<<"$found" | sort | tr '\n' ' ')" = "$(tr ' ' '\n' <<<"$expected" | sort | tr '\n' ' ')" ]; then
  echo "OK: exactly the two expected assignments."
else
  die "assignments differ from the expected two; fix them before continuing"
fi
