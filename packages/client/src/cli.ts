#!/usr/bin/env node
// mema / memory-anywhere (config-and-cli.md §4): the CLI, and the entry points the coding tools
// run (`mcp`, the stdio proxy, and `hook`). Every command is one row of COMMANDS: its group in the
// help, a one-line summary, its own flags and its handler. Usage text, `mema <command> --help` and
// the answer to an unknown flag all come from that table.
//
// Exit codes: 0 ok; 1 usage or other error; 2 store unavailable; 3 refused by the store
// (validation, policy, client too old); 4 conflict; 5 not authorized (no sign-in, approval denied
// or expired); 6 doctor found a problem.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { currentPaths } from "@memory-anywhere/contracts/paths";
import { cdkWorkspace } from "@memory-anywhere/deploy-aws/dir";
import { appDataCheck, currentAppDataView } from "./appdata.ts";
import * as cmd from "./commands.ts";
import { CLIENT_VERSION, loadClientConfig } from "./config.ts";
import { defaultFileDeps, deployAws, destroyAws, type Deps } from "./deploy/aws.ts";
import { costAws } from "./deploy/cost.ts";
import { DeployError, runProcess } from "./deploy/process.ts";
import { hookEvent, readHookInput, runHook, type HookTool } from "./hooks.ts";
import { ask, confirm } from "./prompt.ts";
import { hostTool, runProxy, type ProxyTool } from "./proxy.ts";
import { StepUpError } from "./stepup.ts";
import { StoreClient, StoreError } from "./store-client.ts";

export const EXIT = {
	ok: 0,
	usage: 1,
	error: 1,
	offline: 2,
	rejected: 3,
	conflict: 4,
	unauthorized: 5,
	doctorFailed: 6,
} as const;

// ---------------------------------------------------------------- the command table

interface Flag {
	readonly type: "string" | "boolean";
	readonly help: string;
	/** The value's name in help, e.g. "<file>". */
	readonly arg?: string;
	readonly multiple?: boolean;
	readonly default?: string | boolean;
	/** Accepted, but left out of the help: for development and drills. */
	readonly hidden?: boolean;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Run {
	readonly values: Values;
	readonly positionals: string[];
	/** Store, config and terminal access, built on first use (deploy and cost need none of it). */
	readonly deps: () => cmd.CommandDeps;
}

interface Command {
	readonly name: string;
	readonly group: Group;
	readonly summary: string;
	/** Positional arguments in the usage line, e.g. "<query>". */
	readonly args?: string;
	readonly flags?: Readonly<Record<string, Flag>>;
	/** Resolves to an exit code, or to anything else for success. */
	readonly run: (r: Run) => Promise<unknown>;
}

const GROUPS = ["Set up", "Every day", "Your memories", "Your own server", "Coding tools"] as const;
type Group = (typeof GROUPS)[number];

const str = (v: Values, k: string): string | undefined => (typeof v[k] === "string" ? v[k] : undefined);
const list = (v: Values, k: string): string[] => {
	const x = v[k];
	return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
};
const PROFILE: Flag = { type: "string", arg: "<profile>", default: "memory-anywhere-deploy", help: "AWS CLI profile" };
const REGION: Flag = { type: "string", arg: "<region>", help: "AWS region (default: the profile's)" };

const COMMANDS: readonly Command[] = [
	{
		name: "init",
		group: "Set up",
		summary: "set up memory on this computer",
		flags: {
			local: { type: "boolean", help: "keep the store on this computer instead of a server" },
			clients: { type: "string", arg: "<list>", help: "coding tools to set up (default: every one found)" },
			"dry-run": { type: "boolean", help: "show every change, make none" },
			yes: { type: "boolean", help: "do not ask before changing files" },
			"print-custom-instruction": { type: "boolean", help: "print the text to paste into chat apps, and stop" },
			"from-workspace": {
				type: "string",
				arg: "<checkout>",
				help: "use a repository checkout instead of the installed package",
				hidden: true,
			},
		},
		run: async ({ values, deps }) => {
			const d = deps();
			if (values["print-custom-instruction"]) return void cmd.printCustomInstruction(d);
			warnIfVirtualized(d);
			const { init } = await import("./init.ts");
			await init(d, {
				local: values["local"] === true,
				fromWorkspace: str(values, "from-workspace"),
				clients: str(values, "clients"),
				dryRun: values["dry-run"] === true,
				yes: values["yes"] === true,
			});
		},
	},
	{
		name: "connect",
		group: "Set up",
		summary: "use the store at <url>",
		args: "<url>",
		run: async ({ positionals, deps }) => {
			if (!positionals[0]) return usageError("connect", "connect needs a URL");
			warnIfVirtualized(deps());
			await cmd.connect(deps(), positionals[0]);
		},
	},
	{
		name: "login",
		group: "Set up",
		summary: "sign this computer in to your store",
		flags: { "no-browser": { type: "boolean", help: "print the sign-in link instead of opening it" } },
		run: async ({ values, deps }) => {
			warnIfVirtualized(deps());
			await cmd.login(deps(), values["no-browser"] !== true);
		},
	},
	{ name: "logout", group: "Set up", summary: "sign this computer out", run: ({ deps }) => cmd.logout(deps()) },
	{
		name: "doctor",
		group: "Set up",
		summary: "check the setup and say what to fix",
		run: async ({ deps }) => {
			const { doctor } = await import("./doctor.ts");
			return (await doctor(deps())) ? EXIT.ok : EXIT.doctorFailed;
		},
	},
	{
		name: "status",
		group: "Every day",
		summary: "the store, this computer's sign-in and queued saves",
		run: ({ deps }) => cmd.status(deps()),
	},
	{
		name: "search",
		group: "Every day",
		summary: "look something up in your memory",
		args: "<query>",
		flags: {
			section: { type: "string", arg: "<name>", help: "only this section, e.g. Preferences" },
			limit: { type: "string", arg: "<1..10>", help: "how many results (default 6)" },
		},
		run: async ({ values, positionals, deps }) => {
			const query = positionals.join(" ").trim();
			if (!query) return usageError("search", "search needs a query");
			const limit = str(values, "limit");
			await cmd.search(deps(), query, str(values, "section"), limit === undefined ? undefined : Number(limit));
		},
	},
	{
		name: "sync",
		group: "Every day",
		summary: "send queued saves and refresh the caches",
		flags: { quiet: { type: "boolean", help: "print nothing unless something fails" } },
		run: ({ values, deps }) => cmd.sync(deps(), values["quiet"] === true),
	},
	{
		name: "enable",
		group: "Coding tools",
		summary: "turn memory on in this repository",
		flags: {
			capture: { type: "boolean", help: "also learn from the prompts typed here" },
			"no-capture": { type: "boolean", help: "stop learning from prompts" },
			track: { type: "boolean", help: "keep this repository as a project in your memory" },
			"no-track": { type: "boolean", help: "do not keep it as a project" },
		},
		run: ({ values, deps }) =>
			cmd.enable(deps(), {
				capture: values["capture"] === true && values["no-capture"] !== true,
				track: values["track"] === true ? true : values["no-track"] === true ? false : undefined,
			}),
	},
	{
		name: "disable",
		group: "Coding tools",
		summary: "turn memory off in this repository",
		run: ({ deps }) => cmd.disable(deps()),
	},
	{
		name: "project",
		group: "Coding tools",
		summary: "keep a project in your memory",
		args: "track | add <name>",
		flags: {
			name: { type: "string", arg: "<name>", help: "track: the project's name (default: the folder's)" },
			"repo-url": { type: "string", arg: "<url>", help: "track: the repository's URL" },
			alias: { type: "string", multiple: true, arg: "<alias>", help: "add: another name for it (repeatable)" },
			status: { type: "string", arg: "<status>", help: "add: e.g. active, paused, done" },
			goal: { type: "string", arg: "<text>", help: "add: what the project is for" },
		},
		run: async ({ values, positionals, deps }) => {
			const [sub, ...names] = positionals;
			if (sub === "track") return cmd.projectTrack(deps(), str(values, "name"), str(values, "repo-url"));
			if (sub === "add" && names.length > 0)
				return cmd.projectAdd(
					deps(),
					names.join(" "),
					list(values, "alias"),
					str(values, "status"),
					str(values, "goal"),
				);
			return usageError("project", "project needs `track` or `add <name>`");
		},
	},
	{
		name: "review",
		group: "Your memories",
		summary: "list what waits for your approval, or approve and reject it",
		flags: {
			approve: { type: "string", multiple: true, arg: "<id>", help: "approve this item (repeatable)" },
			reject: { type: "string", multiple: true, arg: "<id>", help: "reject this item (repeatable)" },
		},
		run: ({ values, deps }) => cmd.review(deps(), list(values, "approve"), list(values, "reject")),
	},
	{
		name: "import",
		group: "Your memories",
		summary: "bring in what another app knows about you",
		args: "[<file-or-folder>]",
		flags: {
			source: { type: "string", arg: "<type>", help: "what the file is, e.g. chatgpt-history" },
			"dry-run": { type: "boolean", help: "count what would be imported and its cost" },
			commit: { type: "boolean", help: "import it (after a dry run)" },
			resume: { type: "string", arg: "<batch>", help: "continue a stopped import" },
			vendor: { type: "string", arg: "<name>", help: "for a pasted list: which app it came from" },
			since: { type: "string", arg: "<date>", help: "only conversations from this date on" },
			until: { type: "string", arg: "<date>", help: "only conversations up to this date" },
			"conversation-min-user-turns": { type: "string", arg: "<n>", help: "skip shorter conversations (default 2)" },
		},
		run: async ({ values, positionals, deps }) => {
			const { importCommand } = await import("./import.ts");
			const { isSourceType, SOURCE_TYPES } = await import("@memory-anywhere/importers");
			const source = str(values, "source") ?? "";
			if (!isSourceType(source)) return usageError("import", `import needs --source <${SOURCE_TYPES.join("|")}>`);
			if ((values["dry-run"] === true) === (values["commit"] === true))
				return usageError("import", "import needs one of --dry-run or --commit");
			if (positionals.length > 1) return usageError("import", "import takes one file or folder");
			const turns = str(values, "conversation-min-user-turns");
			await importCommand(deps(), {
				target: positionals[0],
				source,
				mode: values["commit"] === true ? "commit" : "dry-run",
				vendor: str(values, "vendor"),
				resume: str(values, "resume"),
				since: str(values, "since"),
				until: str(values, "until"),
				conversationMinUserTurns: turns === undefined ? undefined : Number(turns),
			});
		},
	},
	{
		name: "export",
		group: "Your memories",
		summary: "save an encrypted copy of your whole memory",
		flags: {
			out: { type: "string", arg: "<file>", help: "where to write it (required)" },
			recipient: { type: "string", arg: "<age1…>", help: "encrypt to this key instead of your registered one" },
			"include-auth": { type: "boolean", help: "include sign-ins, so the copy can replace the store" },
			section: { type: "string", arg: "projects", help: "export only the project catalog, with --format json" },
			format: { type: "string", arg: "json", help: "with --section projects: plain JSON" },
		},
		run: async ({ values, deps }) => {
			const out = str(values, "out");
			if (!out) return usageError("export", "export needs --out <file>");
			const section = str(values, "section");
			const format = str(values, "format");
			const projects = section === "projects";
			if ((section !== undefined && !projects) || (format !== undefined && (format !== "json" || !projects)))
				return usageError("export", "export takes --section projects --format json, or neither");
			await cmd.exportStore(deps(), {
				out,
				projects,
				includeAuth: values["include-auth"] === true,
				recipient: str(values, "recipient"),
			});
		},
	},
	{ name: "ui", group: "Your memories", summary: "open your admin page", run: ({ deps }) => cmd.ui(deps()) },
	{
		name: "version",
		group: "Every day",
		summary: "this client's and your store's versions",
		run: ({ deps }) => cmd.version(deps()),
	},
	{
		name: "deploy",
		group: "Your own server",
		summary: "create or update your server on AWS",
		args: "aws",
		flags: {
			stage: { type: "string", arg: "prod", help: "which server (required)" },
			update: { type: "boolean", help: "update a server that exists" },
			release: {
				type: "string",
				arg: "<version>",
				help: "the signed server release to upload and run (without it, only the stack changes)",
			},
			"alert-email": { type: "string", arg: "<address>", help: "where alerts go (default: MA_ALERT_EMAIL)" },
			yes: { type: "boolean", help: "do not ask before applying the changes" },
			region: REGION,
			profile: PROFILE,
			"release-file": { type: "string", arg: "<tarball>", help: "a locally built release", hidden: true },
			"allow-replace": { type: "boolean", help: "allow rebuilding prod's server", hidden: true },
			"replace-instance": { type: "boolean", help: "rebuild the server from the backup", hidden: true },
			dns: { type: "string", arg: "manual", default: "manual", help: "DNS records are added by you", hidden: true },
		},
		run: ({ values, positionals }) => deployCommand("deploy", positionals, values),
	},
	{
		name: "destroy",
		group: "Your own server",
		summary: "delete a server and its data (prod keeps its buckets and key)",
		args: "aws",
		flags: {
			stage: { type: "string", arg: "<stage>", help: "which server (required)" },
			region: REGION,
			profile: PROFILE,
		},
		run: ({ values, positionals }) => deployCommand("destroy", positionals, values),
	},
	{
		name: "cost",
		group: "Your own server",
		summary: "this month's AWS bill",
		args: "aws",
		flags: { month: { type: "string", arg: "<YYYY-MM>", help: "another month" }, profile: PROFILE },
		run: async ({ values, positionals }) => {
			if (positionals[0] !== "aws" || positionals.length > 1) return usageError("cost", "cost needs the target aws");
			const month = str(values, "month");
			return reportDeployErrors("cost aws", () =>
				costAws(
					{ profile: str(values, "profile") ?? (PROFILE.default as string), ...(month ? { month } : {}) },
					{ run: runProcess, now: Date.now, log: (line) => console.log(line) },
				),
			);
		},
	},
];

// ---------------------------------------------------------------- help

const flagSynopsis = (name: string, f: Flag): string => `--${name}${f.arg ? ` ${f.arg}` : ""}`;

/** `mema` and `mema --help`: what it is, the commands by group, and where to start. */
export function overview(): string {
	const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args ?? ""}`.trim().length));
	const lines = ["mema: one personal memory for all your AI apps", ""];
	for (const g of GROUPS) {
		lines.push(g);
		for (const c of COMMANDS.filter((x) => x.group === g))
			lines.push(`  ${`${c.name} ${c.args ?? ""}`.trim().padEnd(width)}  ${c.summary}`);
		lines.push("");
	}
	lines.push("Start with `mema init`. `mema <command> --help` shows a command's options.");
	return lines.join("\n");
}

/** `mema <command> --help`. */
export function commandHelp(c: Command): string {
	const flags = Object.entries(c.flags ?? {}).filter(([, f]) => !f.hidden);
	const usage = [`mema ${c.name}`, c.args ?? "", flags.length > 0 ? "[options]" : ""].filter(Boolean).join(" ");
	const lines = [`usage: ${usage}`, "", c.summary];
	if (flags.length > 0) {
		const width = Math.max(...flags.map(([n, f]) => flagSynopsis(n, f).length));
		lines.push("", "options:", ...flags.map(([n, f]) => `  ${flagSynopsis(n, f).padEnd(width)}  ${f.help}`));
	}
	return lines.join("\n");
}

function usageError(command: string, message: string): number {
	const c = COMMANDS.find((x) => x.name === command);
	console.error(`mema ${command}: ${message}\n\n${c ? commandHelp(c) : overview()}`);
	return EXIT.usage;
}

// ---------------------------------------------------------------- entry

const HOOK_TOOLS: readonly HookTool[] = ["claude-code", "codex", "cursor"];
const PROXY_TOOLS: readonly ProxyTool[] = ["claude-code", "codex", "cursor", "generic"];

export async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	// The coding tools' entry points come first: a hook must answer fast and never fail its tool.
	if (name === "hook") return hook(rest);
	if (name === "mcp") return proxy(rest);

	if (name === undefined || name === "help" || name === "--help" || name === "-h") {
		const c = COMMANDS.find((x) => x.name === rest[0]);
		console.log(c ? commandHelp(c) : overview());
		return EXIT.ok;
	}
	if (name === "--version" || name === "-v") {
		console.log(CLIENT_VERSION);
		return EXIT.ok;
	}
	const command = COMMANDS.find((c) => c.name === name);
	if (!command) {
		console.error(`mema: there is no command \`${name}\`.\n\n${overview()}`);
		return EXIT.usage;
	}

	let parsed: { values: Values; positionals: string[] };
	try {
		parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: parseOptions(command) });
	} catch (e) {
		if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS_"))
			return usageError(command.name, (e as Error).message);
		throw e;
	}
	if (parsed.values["help"] === true) {
		console.log(commandHelp(command));
		return EXIT.ok;
	}

	let built: cmd.CommandDeps | undefined;
	const deps = (): cmd.CommandDeps => (built ??= commandDeps());
	try {
		const code = await command.run({ values: parsed.values, positionals: parsed.positionals, deps });
		return typeof code === "number" ? code : EXIT.ok;
	} catch (e) {
		console.error(`mema ${command.name}: ${(e as Error).message}`);
		if (e instanceof StepUpError) return EXIT.unauthorized;
		if (e instanceof StoreError) {
			if (e.kind === "offline") return EXIT.offline;
			if (e.kind === "unauthorized") return EXIT.unauthorized;
			return e.status === 409 ? EXIT.conflict : EXIT.rejected;
		}
		return EXIT.error;
	}
}

function parseOptions(c: Command): ParseArgsOptionsConfig {
	const options: ParseArgsOptionsConfig = { help: { type: "boolean", short: "h" } };
	for (const [name, f] of Object.entries(c.flags ?? {})) {
		options[name] = {
			type: f.type,
			...(f.multiple ? { multiple: true } : {}),
			...(f.default !== undefined ? { default: f.default } : {}),
		};
	}
	return options;
}

function commandDeps(): cmd.CommandDeps {
	const paths = currentPaths();
	const { config } = loadClientConfig(paths);
	return {
		paths,
		config,
		store: StoreClient.from(config, paths),
		cwd: process.cwd(),
		out: (l) => console.log(l),
		ask,
		now: Date.now,
		sleep,
		openBrowser,
	};
}

/** connect, login and init write client.toml and tokens.json: inside an app package's container those writes stay in that app. */
function warnIfVirtualized(d: cmd.CommandDeps): void {
	const c = appDataCheck(currentAppDataView(d.paths));
	if (c.verdict !== "pass") console.error(`warning: ${c.detail}.\n${c.fix ?? ""}`);
}

async function hook(args: string[]): Promise<number> {
	const [tool, eventName] = args;
	const event = eventName ? hookEvent(eventName) : undefined;
	if (!tool || !HOOK_TOOLS.includes(tool as HookTool) || !event) return EXIT.ok;
	const paths = currentPaths();
	const { config } = loadClientConfig(paths);
	const input = await readHookInput(process.stdin);
	const store = StoreClient.from(config, paths);
	const out = await runHook(tool as HookTool, event, input, { paths, config, store, env: process.env, now: Date.now });
	if (out) process.stdout.write(out);
	return EXIT.ok;
}

function proxy(args: string[]): number {
	const { values } = parseArgs({ args, options: { tool: { type: "string", default: "generic" } }, strict: false });
	const tool = typeof values.tool === "string" ? values.tool : "generic";
	if (!PROXY_TOOLS.includes(tool as ProxyTool)) {
		console.error(`mema mcp: unknown --tool ${tool}; use ${PROXY_TOOLS.join(", ")}`);
		return EXIT.usage;
	}
	const paths = currentPaths();
	const { config } = loadClientConfig(paths);
	runProxy({
		paths,
		config,
		store: StoreClient.from(config, paths),
		tool: hostTool(tool as ProxyTool, process.env),
		env: process.env,
		cwd: process.cwd(),
		now: Date.now,
	});
	return EXIT.ok;
}

/**
 * Opens `url` in the default browser without a shell, so no character in it is interpreted.
 * `MA_NO_BROWSER` turns this off and the caller prints the link instead: scripted runs, such as the
 * evals, must not open pages in a person's browser.
 */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if ((env["MA_NO_BROWSER"] ?? "").trim() !== "" || !/^https?:\/\//u.test(url)) return false;
	const [command, args] =
		process.platform === "win32"
			? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	return new Promise((resolve) => {
		const child = spawn(command, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", () => resolve(false));
		child.once("spawn", () => {
			child.unref();
			resolve(true);
		});
	});
}

// ---------------------------------------------------------------- deploy, destroy, cost

async function reportDeployErrors(what: string, run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
		return EXIT.ok;
	} catch (e) {
		// A DeployError is written for the person; anything else is a bug, so its stack helps.
		console.error(`mema ${what}: ${e instanceof DeployError ? e.message : ((e as Error).stack ?? String(e))}`);
		return EXIT.error;
	}
}

async function deployCommand(command: "deploy" | "destroy", positionals: string[], values: Values): Promise<number> {
	if (positionals[0] !== "aws" || positionals.length > 1) return usageError(command, `${command} needs the target aws`);
	const stage = str(values, "stage");
	const profile = str(values, "profile") ?? (PROFILE.default as string);
	if (!stage) return usageError(command, "--stage is required");
	const region = str(values, "region") ?? (await defaultRegion(profile));
	if (!region) {
		console.error(`mema ${command}: no AWS region: pass --region, or set one for the profile ${profile}`);
		return EXIT.usage;
	}
	const paths = currentPaths();
	const deps: Deps = {
		run: runProcess,
		fetch: (url, init) => fetch(url, init),
		sleep,
		now: Date.now,
		log: (line) => console.log(line),
		confirm,
		env: process.env,
		devKeyFile: paths.devReleaseKeyFile,
		devPubFile: paths.devReleasePubFile,
		cdk: cdkWorkspace(paths.configDir),
		...defaultFileDeps,
	};
	const common = { stage, region, profile };
	if (command === "destroy") return reportDeployErrors("destroy aws", () => destroyAws(common, deps));
	const release = str(values, "release");
	const releaseFile = str(values, "release-file");
	const alertEmail = str(values, "alert-email");
	return reportDeployErrors("deploy aws", () =>
		deployAws(
			{
				...common,
				update: values["update"] === true,
				yes: values["yes"] === true,
				dns: str(values, "dns") ?? "manual",
				allowReplace: values["allow-replace"] === true,
				replaceInstance: values["replace-instance"] === true,
				...(release ? { release } : {}),
				...(releaseFile ? { releaseFile } : {}),
				...(alertEmail ? { alertEmail } : {}),
			},
			deps,
		),
	);
}

async function defaultRegion(profile: string): Promise<string | undefined> {
	const r = await runProcess("aws", ["configure", "get", "region", "--profile", profile]);
	return r.code === 0 && r.stdout ? r.stdout : undefined;
}

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	// The proxy keeps running on stdio; everything else ends here.
	if (process.argv[2] !== "mcp") process.exit(code);
}
