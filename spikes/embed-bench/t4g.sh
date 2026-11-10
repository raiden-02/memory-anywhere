#!/bin/bash
# Q14 on the spike instance (t4g.small): runs from the unpacked embed-bench bundle, as root
# through SSM Run Command. Fetches the pinned models from Hugging Face, checks their SHA-256
# against the owner's PC, then measures each candidate's query latency and RSS on CPU.
set -euo pipefail
cd "$(dirname "$0")"
NODE=/opt/memory-anywhere/node/bin/node
token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
echo "RESULT instance=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-type)"
"$NODE" src/fetch-models.ts >/dev/null 2>&1
"$NODE" -e '
const exp=require("./expected-hashes.json"), got=require("./out/models/hashes.json");
const bad=Object.keys(exp).filter(k=>exp[k]!==got[k]);
console.log("RESULT model_hashes_match="+(bad.length?"NO "+bad.join(" "):"yes ("+Object.keys(exp).length+" files)"));
if(bad.length) process.exit(1);'
for m in bge-small-en-v1.5-q8 e5-small-v2-q8 embeddinggemma-300m-q8 embeddinggemma-300m-q4; do
  echo "RESULT latency $("$NODE" src/latency.ts "$m" queries-dev.json 2>/dev/null | tail -n1)"
done
