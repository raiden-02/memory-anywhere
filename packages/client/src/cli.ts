#!/usr/bin/env node
// mema / memory-anywhere (config-and-cli.md §4). One entry point for the CLI, the stdio proxy
// (`mcp`) and the hooks (`hook`). Exit codes: 0 ok, 1 error, 2 usage, 3 store unreachable,
// 4 refused by the store, 5 not authorized, 6 client too old.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { currentPaths } from "@memory-anywhere/contracts/paths";
import * as cmd from "./commands.ts";
import { loadClientConfig } from "./config.ts";
import { defaultFileDeps, deployAws, destroyAws, type Deps } from "./deploy/aws.ts";
import { DeployError, runProcess } from "./deploy/process.ts";
import { hookEvent, readHookInput, runHook, type HookTool } from "./hooks.ts";
import { runProxy, type ProxyTool } from "./proxy.ts";
import { StoreClient, StoreError } from "./store-client.ts";

const USAGE = `usage: mema <command> [flags]

  status | sync [--quiet] | version | doctor
  search <query> [--section <name>] [--limit <1..10>]
  enable [--capture|--no-capture] [--track|--no-track] | disable
  project track [--name <n>] [--repo-url <u>] | project add <name> [--alias <a>]… [--status <s>] [--goal "<g>"]
  review [--approve <id>…] [--reject <id>…]
  init [--local --from-workspace <path>] [--clients <list>] [--dry-run] [--yes] [--print-custom-instruction]
  connect <url>
  mcp --tool <claude-code|codex|cursor|generic>
  hook <claude-code|codex|cursor> <event>
  deploy aws --stage <prod|spike|eval-<id>> [--region <r>] [--profile <p>] [--update] [--release-file <tarball>] [--yes] [--dns manual] [--alert-email <address>]
  destroy aws --stage <stage> [--region <r>] [--profile <p>]`;

export const EXIT = { ok: 0, error: 1, usage: 2, offline: 3, rejected: 4, unauthorized: 5, tooOld: 6 } as const;

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim() || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/iu.test(await ask(`${question} [y/N]`, "n"));
}

async function defaultRegion(profile: string): Promise<string | undefined> {
  const r = await runProcess("aws", ["configure", "get", "region", "--profile", profile]);
  return r.code === 0 && r.stdout ? r.stdout : undefined;
}

const HOOK_TOOLS: readonly HookTool[] = ["claude-code", "codex", "cursor"];
const PROXY_TOOLS: readonly ProxyTool[] = ["claude-code", "codex", "cursor", "generic"];

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = currentPaths();

  // Hooks first: they must never throw and must answer fast.
  if (command === "hook") {
    const [tool, eventName] = rest;
    const event = eventName ? hookEvent(eventName) : undefined;
    if (!tool || !HOOK_TOOLS.includes(tool as HookTool) || !event) return EXIT.ok;
    const { config } = loadClientConfig(paths);
    const input = await readHookInput(process.stdin);
    const out = await runHook(tool as HookTool, event, input, { paths, config, store: StoreClient.from(config, paths), env: process.env, now: Date.now });
    if (out) process.stdout.write(out);
    return EXIT.ok;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      tool: { type: "string" }, quiet: { type: "boolean", default: false }, section: { type: "string" }, limit: { type: "string" },
      capture: { type: "boolean" }, "no-capture": { type: "boolean" }, track: { type: "boolean" }, "no-track": { type: "boolean" },
      name: { type: "string" }, "repo-url": { type: "string" }, alias: { type: "string", multiple: true }, status: { type: "string" }, goal: { type: "string" },
      approve: { type: "string", multiple: true }, reject: { type: "string", multiple: true },
      local: { type: "boolean", default: false }, "from-workspace": { type: "string" }, clients: { type: "string" }, "dry-run": { type: "boolean", default: false },
      "print-custom-instruction": { type: "boolean", default: false },
      stage: { type: "string" }, region: { type: "string" }, profile: { type: "string", default: "memory-anywhere-deploy" }, update: { type: "boolean", default: false },
      release: { type: "string" }, "release-file": { type: "string" }, yes: { type: "boolean", default: false }, dns: { type: "string", default: "manual" },
      "alert-email": { type: "string" }, help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? EXIT.ok : EXIT.usage;
  }

  if (command === "deploy" || command === "destroy") return deployCommand(command, positionals, values);

  const { config } = loadClientConfig(paths);
  const store = StoreClient.from(config, paths);
  const deps: cmd.CommandDeps = { paths, config, store, cwd: process.cwd(), out: (l) => console.log(l), ask, now: Date.now };

  if (command === "mcp") {
    const tool = values.tool ?? "generic";
    if (!PROXY_TOOLS.includes(tool as ProxyTool)) return usage(`unknown --tool ${tool}`);
    runProxy({ paths, config, store, tool: tool as ProxyTool, env: process.env, cwd: process.cwd(), now: Date.now });
    return EXIT.ok;
  }

  try {
    switch (command) {
      case "status": await cmd.status(deps); break;
      case "sync": await cmd.sync(deps, values.quiet); break;
      case "version": await cmd.version(deps); break;
      case "search": {
        const query = positionals.join(" ").trim();
        if (!query) return usage("search needs a query");
        await cmd.search(deps, query, values.section, values.limit ? Number(values.limit) : undefined);
        break;
      }
      case "enable": await cmd.enable(deps, { capture: values.capture === true && values["no-capture"] !== true, track: values.track ? true : values["no-track"] ? false : undefined }); break;
      case "disable": await cmd.disable(deps); break;
      case "project": {
        const [sub, ...names] = positionals;
        if (sub === "track") await cmd.projectTrack(deps, values.name, values["repo-url"]);
        else if (sub === "add" && names.length > 0) await cmd.projectAdd(deps, names.join(" "), values.alias ?? [], values.status, values.goal);
        else return usage("project track | project add <name>");
        break;
      }
      case "review": await cmd.review(deps, values.approve ?? [], values.reject ?? []); break;
      case "connect": {
        if (!positionals[0]) return usage("connect needs a URL");
        await cmd.connect(deps, positionals[0]);
        break;
      }
      case "init": {
        if (values["print-custom-instruction"]) {
          cmd.printCustomInstruction(deps);
          break;
        }
        const { init } = await import("./init.ts");
        await init(deps, { local: values.local, fromWorkspace: values["from-workspace"], clients: values.clients, dryRun: values["dry-run"], yes: values.yes });
        break;
      }
      case "doctor": {
        const { doctor } = await import("./doctor.ts");
        return (await doctor(deps)) ? EXIT.ok : EXIT.error;
      }
      default:
        return usage(`unknown command ${command}`);
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof StoreError) {
      console.error(`mema ${command}: ${e.message}`);
      return e.kind === "offline" ? EXIT.offline : e.kind === "unauthorized" ? EXIT.unauthorized : e.kind === "too_old" ? EXIT.tooOld : EXIT.rejected;
    }
    console.error(`mema ${command}: ${(e as Error).message}`);
    return EXIT.error;
  }
}

function usage(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return EXIT.usage;
}

async function deployCommand(command: "deploy" | "destroy", positionals: string[], values: Record<string, unknown>): Promise<number> {
  const [target] = positionals;
  if (target !== "aws" || positionals.length > 1) return usage(`${command} needs the target aws`);
  const stage = values["stage"] as string | undefined;
  const profile = values["profile"] as string;
  if (!stage) return usage("--stage is required");
  const region = (values["region"] as string | undefined) ?? (await defaultRegion(profile));
  if (!region) {
    console.error(`no region: pass --region or set one for profile ${profile}`);
    return EXIT.usage;
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
  const common = { stage, region, profile };
  try {
    if (command === "deploy") {
      await deployAws(
        {
          ...common,
          update: values["update"] === true,
          yes: values["yes"] === true,
          dns: values["dns"] as string,
          ...(values["release-file"] ? { releaseFile: values["release-file"] as string } : {}),
          ...(values["release"] ? { release: values["release"] as string } : {}),
          ...(values["alert-email"] ? { alertEmail: values["alert-email"] as string } : {}),
        },
        deps,
      );
    } else {
      await destroyAws(common, deps);
    }
    return EXIT.ok;
  } catch (e) {
    console.error(`mema ${command} aws: ${e instanceof DeployError ? e.message : (e as Error).stack ?? String(e)}`);
    return EXIT.error;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // The proxy keeps running on stdio; everything else ends here.
  if (process.argv[2] !== "mcp") process.exit(code);
}
