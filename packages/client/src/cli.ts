#!/usr/bin/env node
// mema / memory-anywhere (config-and-cli.md §4). In M0 only the deploy commands exist.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { currentPaths } from "@memory-anywhere/contracts/paths";
import { defaultFileDeps, deployAws, destroyAws, type Deps } from "./deploy/aws.ts";
import { DeployError, runProcess } from "./deploy/process.ts";

const USAGE = `usage:
  mema deploy aws --stage <prod|spike|eval-<id>> [--region <r>] [--profile <p>] [--update]
                  [--release-file <tarball>] [--yes] [--dns manual] [--alert-email <address>]
  mema destroy aws --stage <stage> [--region <r>] [--profile <p>]`;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function defaultRegion(profile: string): Promise<string | undefined> {
  const r = await runProcess("aws", ["configure", "get", "region", "--profile", profile]);
  return r.code === 0 && r.stdout ? r.stdout : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      region: { type: "string" },
      profile: { type: "string", default: "memory-anywhere-deploy" },
      update: { type: "boolean", default: false },
      release: { type: "string" },
      "release-file": { type: "string" },
      yes: { type: "boolean", default: false },
      dns: { type: "string", default: "manual" },
      "alert-email": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (target !== "aws" || (command !== "deploy" && command !== "destroy") || positionals.length > 2) {
    console.error(USAGE);
    return 1;
  }
  if (!values.stage) {
    console.error("--stage is required\n" + USAGE);
    return 1;
  }
  const region = values.region ?? (await defaultRegion(values.profile));
  if (!region) {
    console.error(`no region: pass --region or set one for profile ${values.profile}`);
    return 1;
  }
  const deps: Deps = {
    run: runProcess,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    confirm,
    env: process.env,
    devKeyFile: currentPaths().devReleaseKeyFile,
    ...defaultFileDeps,
  };
  const common = { stage: values.stage, region, profile: values.profile };
  try {
    if (command === "deploy") {
      await deployAws(
        {
          ...common,
          update: values.update,
          yes: values.yes,
          dns: values.dns,
          ...(values["release-file"] ? { releaseFile: values["release-file"] } : {}),
          ...(values.release ? { release: values.release } : {}),
          ...(values["alert-email"] ? { alertEmail: values["alert-email"] } : {}),
        },
        deps,
      );
    } else {
      await destroyAws(common, deps);
    }
    return 0;
  } catch (e) {
    console.error(`mema ${command} aws: ${e instanceof DeployError ? e.message : (e as Error).stack ?? String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
