#!/bin/bash
# Operator tasks for memory-anywhere (deployment-aws.md §3.2 C, §5.5, §5.6).
# Run in AWS CloudShell of the memory-anywhere account, signed in as ma-operator
# (permission set memory-anywhere-operator). Not on the PC, except during M0 under the
# owner's temporary decision (spec-issues.md #13: AWS_PROFILE=memory-anywhere-operator).
#
#   ./ma-operator.sh setup-link    [--stage <stage>]
#   ./ma-operator.sh set-llm-key   [--stage <stage>]
#   ./ma-operator.sh restore       --reason lost|compromise [--to <timestamp>] [--stage <stage>]
#   ./ma-operator.sh reset-owner   [--cancel] [--stage <stage>]
#   ./ma-operator.sh acme-account  [--stage <stage>]
#   ./ma-operator.sh import-export --prepare | --file <path> [--include-auth] [--stage <stage>]
#   ./ma-operator.sh delete-data   --stage <stage>
#
# --stage defaults to prod. The region is CloudShell's (AWS_REGION) unless --region is given.
set -euo pipefail
umask 077
# Git Bash on Windows rewrites arguments that start with / (such as SSM parameter names)
# into Windows paths. Turn that off; it has no effect anywhere else.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
# aws.exe on Windows prints with the console code page and fails on characters such as
# systemd's status bullets; ask its Python runtime for UTF-8.
export PYTHONUTF8=1

SERVER=/opt/memory-anywhere/current/bin/memory-anywhere-server

die() { echo "ma-operator: $*" >&2; exit 1; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------- arguments ----------
cmd=${1:-}
if [ -z "$cmd" ] || [ "$cmd" = "-h" ] || [ "$cmd" = "--help" ]; then usage; exit 0; fi
shift
stage=prod
region=${AWS_REGION:-${AWS_DEFAULT_REGION:-}}
reason="" to="" cancel=0 prepare=0 file="" include_auth=0 stage_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) stage=${2:?--stage needs a value}; stage_given=1; shift 2 ;;
    --region) region=${2:?--region needs a value}; shift 2 ;;
    --reason) reason=${2:?--reason needs a value}; shift 2 ;;
    --to) to=${2:?--to needs a value}; shift 2 ;;
    --cancel) cancel=1; shift ;;
    --prepare) prepare=1; shift ;;
    --file) file=${2:?--file needs a value}; shift 2 ;;
    --include-auth) include_auth=1; shift ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[[ "$stage" =~ ^(prod|spike|eval-[a-z0-9]{1,12})$ ]] || die "stage must be prod, spike or eval-<id>"
[ -n "$region" ] || die "no region: run in CloudShell or pass --region"
case "$cmd" in
  setup-link | set-llm-key | restore | reset-owner | acme-account | import-export | delete-data) ;;
  *) die "unknown command $cmd (see --help)" ;;
esac
command -v aws >/dev/null || die "the AWS CLI is required (CloudShell has it)"
command -v node >/dev/null || die "Node.js is required (CloudShell has it)"

# On Windows (Git Bash) aws.exe ends lines with \r; strip it so captured values are clean.
# pipefail (set above) keeps aws's exit status.
aws_() { aws --region "$region" "$@" | tr -d '\r'; }

# json_field <field>: one top-level field of the JSON on stdin ("" if absent).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v))})' "$1"
}

# native_path <path>: a path the AWS CLI can open (Windows form under Git Bash).
native_path() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# ---------- the stage's stack ----------
output() { # output <key>
  aws_ cloudformation describe-stacks --stack-name "MemoryAnywhere-$stage" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
load_stack() {
  instance=$(output InstanceId) || die "stack MemoryAnywhere-$stage not found in $region"
  prefix=$(output ParameterPrefix)
  backup_bucket=$(output BackupBucket)
  key_arn=$(output KeyArn)
  admin_origin=$(output AdminOrigin)
  [ "$instance" != "None" ] || die "stack MemoryAnywhere-$stage has no InstanceId output"
}

# ---------- SSM Run Command ----------
run_on_instance() { # run_on_instance <description> <shell script>; prints its stdout, fails on non-zero
  local what=$1 script=$2 params id status
  params=$(node -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]]}))' "$script")
  id=$(aws_ ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --comment "ma-operator $cmd: $what" --parameters "$params" --query Command.CommandId --output text)
  aws_ ssm wait command-executed --command-id "$id" --instance-id "$instance" 2>/dev/null || true
  status=$(aws_ ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query Status --output text)
  aws_ ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query StandardOutputContent --output text
  if [ "$status" != "Success" ]; then
    aws_ ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query StandardErrorContent --output text >&2
    die "$what failed on $instance ($status)"
  fi
}

get_secure() { # get_secure <name>: prints the decrypted value, or nothing if missing
  aws_ ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true
}

# ---------- commands ----------
setup_link() {
  load_stack
  local value token="" expires="" now
  value=$(get_secure "$prefix/setup-token")
  if [ -n "$value" ]; then
    token=$(printf '%s' "$value" | json_field token)
    expires=$(printf '%s' "$value" | json_field expires_at)
  fi
  now=$(date -u +%s)
  if [ -z "$token" ] || [ "$(date -u -d "$expires" +%s 2>/dev/null || echo 0)" -le "$((now + 60))" ]; then
    echo "Setup token missing or expiring; issuing a fresh 30-minute token on $instance ..."
    local before=$value
    run_on_instance "setup-token --renew" "runuser -u memory-anywhere -- $SERVER setup-token --renew" >/dev/null
    for _ in $(seq 1 30); do # the outbox helper writes the parameter
      value=$(get_secure "$prefix/setup-token")
      if [ -n "$value" ] && [ "$value" != "$before" ]; then break; fi
      sleep 2
    done
    if [ -z "$value" ] || [ "$value" = "$before" ]; then die "the instance did not publish a new setup token within 60 s"; fi
    token=$(printf '%s' "$value" | json_field token)
    expires=$(printf '%s' "$value" | json_field expires_at)
  fi
  echo "Open this link in a private window (valid until $expires):"
  echo "$admin_origin/setup#$token"
}

set_llm_key() {
  load_stack
  local key input
  if [ -t 0 ]; then
    read -r -s -p "LLM API key (input hidden): " key
    echo
  else
    read -r key || true # piped in (never as an argument, which would show in the process list)
  fi
  [ -n "$key" ] || die "empty key"
  input=$(mktemp)
  trap 'shred -u "$input" 2>/dev/null || rm -f "$input"' RETURN
  # The key goes through stdin into a 0600 file, never onto a command line.
  printf '%s' "$key" | node -e 'let v="";process.stdin.on("data",d=>v+=d).on("end",()=>require("fs").writeFileSync(process.argv[2],JSON.stringify({Name:process.argv[1],Type:"SecureString",Overwrite:true,Value:v}),{mode:0o600}))' \
    "$prefix/llm/api_key" "$(native_path "$input")"
  key=""
  # The AWS-managed SSM key, which the instance role can use through SSM; the stack CMK is for S3 only.
  aws_ ssm put-parameter --cli-input-json "file://$(native_path "$input")" >/dev/null
  echo "Stored $prefix/llm/api_key. Restarting the secrets and server units ..."
  run_on_instance "restart secrets and server" "systemctl restart memory-anywhere-secrets.service memory-anywhere.service && systemctl is-active memory-anywhere.service"
}

restore() {
  load_stack
  case "$reason" in lost | compromise) ;; *) die "restore needs --reason lost|compromise" ;; esac
  local ts flag_args=""
  if [ -n "$to" ]; then
    date -u -d "$to" +%FT%TZ >/dev/null 2>&1 || die "--to must be a timestamp such as 2026-11-08T10:00:00Z"
    to=$(date -u -d "$to" +%FT%TZ)
    flag_args="-timestamp $to"
  fi
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  echo "Restoring MemoryAnywhere-$stage on $instance (reason $reason${to:+, to $to}). The server stops during the restore."
  run_on_instance "restore" "set -euo pipefail
d=/var/lib/memory-anywhere
systemctl stop memory-anywhere.service litestream.service
for f in store.db store.db-wal store.db-shm; do if [ -f \$d/\$f ]; then mv \$d/\$f \$d/pre-restore-$ts.\${f#store.}; fi; done
litestream restore -config /etc/litestream.yml -o \$d/store.db $flag_args \$d/store.db
chown memory-anywhere:ma-data \$d/store.db && chmod 0660 \$d/store.db
install -d -m 0770 -o memory-anywhere -g ma-data \$d/maint
printf '{\"reason\":\"%s\",\"to\":\"%s\"}\n' '$reason' '$to' > \$d/maint/restored
chown memory-anywhere:ma-data \$d/maint/restored
systemctl start litestream.service memory-anywhere.service
systemctl is-active memory-anywhere.service"
  echo "Restored. The server starts in restored state and raises alert 'restored'."
}

reset_owner() {
  load_stack
  if [ "$cancel" = 1 ]; then
    run_on_instance "reset-owner --cancel" "runuser -u memory-anywhere -- $SERVER reset-owner --cancel"
  else
    run_on_instance "reset-owner" "runuser -u memory-anywhere -- $SERVER reset-owner"
  fi
}

acme_account() {
  load_stack
  local uri
  uri=$(aws_ ssm get-parameter --name "$prefix/acme/account-uri" --query Parameter.Value --output text 2>/dev/null) ||
    die "no ACME account recorded yet (the instance writes it after its first certificate)"
  echo "$uri"
  echo "Optional CAA hardening (deployment-aws.md §6.2): 0 issue \"letsencrypt.org; accounturi=$uri; validationmethods=tls-alpn-01\""
}

new_ulid() { # 26-character Crockford base32: 48-bit ms time + 80 random bits
  node -e 'const a="0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let n=(BigInt(Date.now())<<80n)|BigInt("0x"+require("crypto").randomBytes(10).toString("hex"));
let s="";for(let i=0;i<26;i++){s=a[Number(n&31n)]+s;n>>=5n}process.stdout.write(s)'
}

import_export() {
  load_stack
  if [ "$prepare" = 1 ]; then
    run_on_instance "import-export --prepare" "runuser -u memory-anywhere -- $SERVER import-export --prepare"
    return
  fi
  [ -n "$file" ] || die "import-export needs --prepare or --file <path>"
  [ -f "$file" ] || die "no such file: $file"
  local ulid auth=""
  ulid=$(new_ulid)
  [ "$include_auth" = 1 ] && auth=" --include-auth"
  aws_ s3 cp --only-show-errors "$file" "s3://$backup_bucket/transfer/$ulid.age" --sse aws:kms --sse-kms-key-id "$key_arn"
  echo "Uploaded as transfer/$ulid.age; importing on $instance ..."
  run_on_instance "import-export" "set -euo pipefail
runuser -u memory-anywhere -- touch /run/memory-anywhere/outbox/fetch-$ulid
for i in \$(seq 1 60); do [ -f /run/memory-anywhere/inbox/drop/$ulid.age ] && break; sleep 2; done
[ -f /run/memory-anywhere/inbox/drop/$ulid.age ] || { echo 'the outbox helper did not fetch the file' >&2; exit 1; }
runuser -u memory-anywhere -- $SERVER import-export --in /run/memory-anywhere/inbox/drop/$ulid.age$auth"
}

delete_data() {
  [ "$stage_given" = 1 ] || die "delete-data needs an explicit --stage"
  if [ "$stage" = prod ]; then
    cat <<'EOF'
Prod backups can only be deleted by the member account's root user (deployment-aws.md §5.2):
  1. Sign out. Open the AWS console sign-in, choose "Root user", enter the memory-anywhere account's
     email, use "Forgot password" to set a password, and add an MFA device.
  2. S3 -> the memory-anywhere-backup-...-prod bucket -> Empty (this removes every version) -> confirm.
  3. Delete the bucket.
  4. KMS -> alias/memory-anywhere-prod -> Schedule key deletion (30 days).
  5. Sign out, and remove the root password again if you do not want to keep it.
EOF
    return
  fi
  load_stack
  local answer
  echo "This permanently deletes every object version in $backup_bucket and then the bucket."
  read -r -p "Type the stage name ($stage) to continue: " answer
  [ "$answer" = "$stage" ] || die "not confirmed"
  node - "$backup_bucket" "$region" <<'EOF'
const { execFileSync } = require("child_process");
const [bucket, region] = process.argv.slice(2);
const aws = (...args) => execFileSync("aws", ["--region", region, ...args], { encoding: "utf8" });
let deleted = 0;
for (;;) {
  const page = JSON.parse(aws("s3api", "list-object-versions", "--bucket", bucket, "--max-items", "1000", "--output", "json") || "{}");
  const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
  if (objects.length === 0) break;
  aws("s3api", "delete-objects", "--bucket", bucket, "--delete", JSON.stringify({ Objects: objects, Quiet: true }));
  deleted += objects.length;
}
console.log(`deleted ${deleted} object versions`);
EOF
  aws_ s3api delete-bucket --bucket "$backup_bucket"
  echo "Deleted $backup_bucket."
}

case "$cmd" in
  setup-link) setup_link ;;
  set-llm-key) set_llm_key ;;
  restore) restore ;;
  reset-owner) reset_owner ;;
  acme-account) acme_account ;;
  import-export) import_export ;;
  delete-data) delete_data ;;
esac
