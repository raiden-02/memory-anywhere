#!/bin/bash
# memory-anywhere-secrets.service (user ma-aws): read <prefix>/llm/api_key into a
# staging file; ExecStartPost hands it to the server user (deployment-aws.md §4).
# A missing key is not an error: the server starts without LLM features.
set -euo pipefail
umask 077
out=/run/ma-aws-secrets/secrets.env
if key=$(aws --region "$MA_REGION" ssm get-parameter --name "$MA_PREFIX/llm/api_key" --with-decryption \
  --query Parameter.Value --output text 2>/dev/null); then
  printf 'MA_LLM_API_KEY=%s\n' "$key" >"$out"
  echo "secrets: LLM key loaded"
else
  : >"$out"
  echo "secrets: no LLM key set ($MA_PREFIX/llm/api_key); starting without it"
fi
