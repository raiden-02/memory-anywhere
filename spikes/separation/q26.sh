#!/bin/bash
# Q26 operator path (m0-spike.md), run with the operator profile:
#   AWS_PROFILE=memory-anywhere-operator bash spikes/separation/q26.sh <evidence file>
# setup-link (renewal through SSM Run Command), set-llm-key (a dummy value: spike only),
# and one direct Run Command that publishes a test alert (Q27) and reports unit states.
# The setup token is redacted before anything is written to the evidence file.
set -euo pipefail
out=${1:?usage: q26.sh <evidence file>}
here=$(cd "$(dirname "$0")" && pwd)
op="$here/../../deploy/aws/ma-operator.sh"
region=us-east-1
aws_() { aws --region "$region" "$@" | tr -d '\r'; }
redact() { sed -E 's/(setup#)[A-Za-z0-9_-]+/\1<redacted>/'; }

{
  echo "# Q26 operator path, $(date -u +%FT%TZ), profile ${AWS_PROFILE:-?} on the owner's PC (M0 exception, spec-issues.md #13)"
  echo "\$ aws sts get-caller-identity"
  aws_ sts get-caller-identity --query Arn --output text
  echo
  echo "\$ ma-operator.sh setup-link --stage spike"
  bash "$op" setup-link --stage spike --region "$region" 2>&1 | redact
  echo
  echo "\$ ma-operator.sh setup-link --stage spike   (second call: reuses the unexpired token)"
  bash "$op" setup-link --stage spike --region "$region" 2>&1 | redact
  echo
  echo "\$ (dummy key piped on stdin) | ma-operator.sh set-llm-key --stage spike"
  printf 'test-key-not-real\n' | bash "$op" set-llm-key --stage spike --region "$region" 2>&1
  echo
  instance=$(aws_ cloudformation describe-stacks --stack-name MemoryAnywhere-spike --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" --output text)
  topic=$(aws_ cloudformation describe-stacks --stack-name MemoryAnywhere-spike --query "Stacks[0].Outputs[?OutputKey=='AlertsTopic'].OutputValue | [0]" --output text)
  script="aws sns publish --region $region --topic-arn $topic --subject 'memory-anywhere spike: Q27 test' --message 'Test notification from the spike instance (M0 Q26/Q27).' --query MessageId --output text && systemctl is-active caddy memory-anywhere memory-anywhere-outbox.path memory-anywhere-secrets && test -s /run/memory-anywhere/secrets.env && echo 'secrets.env present (not shown)'"
  params=$(node -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]]}))' "$script")
  echo "\$ aws ssm send-command (AWS-RunShellScript): publish a test alert, report unit states"
  id=$(aws_ ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript --comment "M0 Q26/Q27 test" --parameters "$params" --query Command.CommandId --output text)
  aws_ ssm wait command-executed --command-id "$id" --instance-id "$instance" 2>/dev/null || true
  aws_ ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}'
} | tee "$out"
