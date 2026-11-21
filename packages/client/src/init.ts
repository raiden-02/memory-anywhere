// `mema init [--local]` (config-and-cli.md §4.1; clients.md §6): sets this computer up, from the
// installed npm package (or, for development, a checkout with --from-workspace).
//
//   1 ask for the git hosts where memory must never be used (the deny-list)
//   2 show every change: client.toml (+ server.toml), each installed coding tool, the skill
//   3 ask once, then make them (a checkout is built first)
//   4 local mode: install the matching server (from the package), stop the old one, the server's
//     init (store, migrations, model), its start at logon, health
//     remote: leave local mode if on, check health, sign this computer in
//   5 what is left for you, then `mema doctor`
//
// `--dry-run` stops after step 2; `--yes` skips the questions.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { currentToolPaths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir } from "@memory-anywhere/contracts/secure-fs";
import os from "node:os";
import type { CommandDeps } from "./commands.ts";
import { leaveLocalMode, printCustomInstruction } from "./commands.ts";
import { login as pcLogin, readTokens } from "./auth.ts";
import { CLIENT_VERSION, clientToml, LOCAL_URL } from "./config.ts";
import { doctor } from "./doctor.ts";
import {
	applyPlan,
	change,
	detectTools,
	describePlan,
	INSTALL_TOOLS,
	planClaudeCode,
	planCodex,
	planCursor,
	planSkill,
	type InstallPlan,
	type InstallTool,
} from "./install.ts";
import {
	registerAndStart,
	serverArgv,
	serverInit,
	serverToml,
	unregisterAndStop,
	waitHealthy,
	workspaceServerCli,
} from "./local-server.ts";
import {
	installedServerCli,
	installServer,
	removeOtherVersions,
	SERVER_PACKAGE,
	serverAppDir,
} from "./server-install.ts";
import { packagedSources, type InstallSources } from "./package-root.ts";
import { isYes } from "./prompt.ts";
import { runTool } from "./tool-runner.ts";

export interface InitOptions {
	readonly local: boolean;
	readonly fromWorkspace: string | undefined;
	readonly clients: string | undefined;
	readonly dryRun: boolean;
	readonly yes: boolean;
}

/** Tools to set up: every installed one, or the --clients list, each of which must be installed. */
function selectTools(clients: string | undefined, home: string): InstallTool[] {
	const installed = detectTools(home);
	if (!clients) return INSTALL_TOOLS.filter((t) => installed[t]);
	const wanted = clients.split(",").map((s) => s.trim());
	for (const w of wanted) {
		if (!INSTALL_TOOLS.includes(w as InstallTool))
			throw new Error(`unknown client ${w}; use ${INSTALL_TOOLS.join(",")}`);
		if (!installed[w as InstallTool]) throw new Error(`${w} is not installed on this computer; install it first`);
	}
	return wanted as InstallTool[];
}

/** The remote store's URL: client.toml's, else asked for. Must be https. */
async function remoteUrl(d: CommandDeps): Promise<string> {
	const configured = d.config.store.mode === "remote" ? d.config.store.url : "";
	const url = (configured || (await d.ask("Your store's URL (for example https://memory.example.com):", ""))).replace(
		/\/+$/u,
		"",
	);
	if (!/^https:\/\/[^/]+$/u.test(url)) throw new Error(`a remote store needs an https origin, not "${url}"`);
	return url;
}

/** Where init takes the plugins, the bundle and (local mode) the server from: a checkout, or the installed package. */
type Sources =
	| (InstallSources & { readonly kind: "workspace"; readonly workspace: string; readonly serverCli: string })
	| (InstallSources & { readonly kind: "package" });

export function sourcesFor(o: InitOptions, packaged: InstallSources | undefined): Sources {
	if (o.fromWorkspace) {
		const workspace = path.resolve(o.fromWorkspace);
		const serverCli = workspaceServerCli(workspace);
		if (!existsSync(serverCli))
			throw new Error(`${workspace} is not a memory-anywhere checkout (no packages/server/src/cli.ts)`);
		return {
			kind: "workspace",
			workspace,
			serverCli,
			pluginsDir: path.join(workspace, "plugins"),
			bundle: path.join(workspace, "packages", "client", "dist", "memory-anywhere.mjs"),
		};
	}
	if (!packaged)
		throw new Error("run mema from the npm package (npm i -g memory-anywhere), or pass --from-workspace <checkout>");
	return { kind: "package", ...packaged };
}

export async function init(
	d: CommandDeps,
	o: InitOptions,
	packaged: InstallSources | undefined = packagedSources(),
): Promise<void> {
	const source = sourcesFor(o, packaged);
	const from = source.kind === "workspace" ? source.workspace : "the installed package";
	const toolPaths = currentToolPaths();
	const home = path.dirname(path.dirname(toolPaths.claudeSettingsFile));
	const tools = selectTools(o.clients, home);
	const storeUrl = o.local ? LOCAL_URL : await remoteUrl(d);

	d.out(
		o.local
			? `memory-anywhere local mode, from ${from}`
			: `memory-anywhere with your store at ${storeUrl}, from ${from}`,
	);
	d.out(`coding tools found: ${tools.join(", ") || "none"}`);
	d.out(
		o.local
			? "Everything stays on this PC: the store, the model, and a token readable only by you."
			: "Your memories live in your store. This PC keeps a sign-in token readable only by you, caches and a spool.",
	);
	const { pluginsDir, bundle } = source;
	// Local mode runs the checkout's server, or the matching server package installed beside this client.
	const appDir = serverAppDir(d.paths, CLIENT_VERSION);
	const serverCli = source.kind === "workspace" ? source.serverCli : installedServerCli(appDir);
	const installsServer = o.local && source.kind === "package" && !existsSync(serverCli);

	// 2. Config files.
	// --yes keeps the current deny-list (edit client.toml [repos] deny_remotes later); otherwise ask.
	const denyRemotes = o.dryRun || o.yes ? d.config.repos.deny_remotes : await askDenyList(d);
	const configPlan: InstallPlan = {
		tool: "config",
		files: [
			...change(d.paths.clientConfigFile, clientToml(o.local ? "local" : "remote", storeUrl, denyRemotes)),
			...(o.local ? change(d.paths.localServerConfigFile, serverToml(d.paths)) : []),
		],
		folders: [],
		commands: [],
		notes: installsServer
			? [`installs ${SERVER_PACKAGE}@${CLIENT_VERSION} with npm (no install scripts) into ${appDir}`]
			: [],
	};
	const claudeServers = tools.includes("claude-code")
		? runTool("claude", ["mcp", "list"], 30_000)
				.stdout.split("\n")
				.map((l) => l.split(":")[0]?.trim() ?? "")
				.filter(Boolean)
		: [];
	const inputs = { paths: d.paths, tools: toolPaths, pluginsDir, claudeServers };
	const plans: InstallPlan[] = [
		configPlan,
		...tools.map((t) =>
			t === "claude-code" ? planClaudeCode(inputs) : t === "codex" ? planCodex(inputs, bundle) : planCursor(inputs),
		),
		planSkill(toolPaths),
	];
	for (const p of plans) d.out(describePlan(p));
	if (o.dryRun) {
		d.out(
			o.local
				? `dry run: would run the server's init, register the logon task and start ${serverArgv(serverCli, d.paths.localServerConfigFile).join(" ")}`
				: `dry run: would ${d.config.store.mode === "local" ? "leave local mode, " : ""}check ${storeUrl}/v1/health and sign this PC in`,
		);
		return;
	}
	if (!o.yes && !isYes(await d.ask("Make these changes? [y/N]", "n")))
		throw new Error("cancelled; nothing was changed");

	// Build, from a checkout only: the client bundle and each plugin's dist/. The package ships them built.
	if (source.kind === "workspace") {
		d.out("building the client bundle…");
		const b = spawnSync(process.execPath, [path.join(source.workspace, "scripts", "build.ts")], {
			cwd: source.workspace,
			encoding: "utf8",
			windowsHide: true,
		});
		if (b.status !== 0) throw new Error(`build failed: ${(b.stderr || b.stdout).trim()}`);
	}

	ensurePrivateDir(d.paths.dataDir);
	ensurePrivateDir(path.dirname(d.paths.clientConfigFile));
	const problems = applyPlan(configPlan, { run: (c, a) => runTool(c, a), now: d.now });

	if (o.local) {
		// 3–5. Server: install, stop the one running, store and model, logon task, health.
		if (installsServer) {
			d.out(`installing ${SERVER_PACKAGE}@${CLIENT_VERSION}…`);
			installServer(appDir, CLIENT_VERSION);
		}
		const launcher = path.join(d.paths.localServerDataDir, "start-hidden.js");
		if (d.config.store.mode === "local") unregisterAndStop(launcher, d.paths.localServerConfigFile);
		await serverInit(serverCli, d.paths.localServerConfigFile);
		registerAndStart(serverArgv(serverCli, d.paths.localServerConfigFile), launcher);
		if (!(await waitHealthy(LOCAL_URL, 60_000)))
			throw new Error("the local server did not become healthy within 60 s; see `mema doctor`");
		if (source.kind === "package") removeOtherVersions(d.paths, CLIENT_VERSION);
		d.out(`server running at ${LOCAL_URL}`);
	} else {
		// 3–5. Leave local mode, check the store, sign in (unless already signed in to it).
		if (d.config.store.mode === "local") leaveLocalMode(d);
		if (!(await waitHealthy(storeUrl, 10_000)))
			throw new Error(`${storeUrl} does not answer /v1/health; check the URL and \`mema deploy\``);
		if (readTokens(d.paths)?.issuer !== storeUrl) {
			await pcLogin(
				storeUrl,
				{ paths: d.paths, fetch, now: d.now, sleep: d.sleep },
				{ out: d.out, openBrowser: d.openBrowser, machineName: os.hostname() },
			);
		}
		d.out(`signed in to ${storeUrl}`);
	}

	// 6–7. Coding tools and the skill.
	for (const p of plans.slice(1)) problems.push(...applyPlan(p, { run: (c, a) => runTool(c, a), now: d.now }));
	for (const p of problems) d.out(`problem: ${p}`);

	// 9. What is left for the owner.
	for (const note of plans.flatMap((p) => p.notes)) d.out(`next: ${note}`);
	d.out("next: in each repository where memory should work, run `mema enable`.");
	d.out("");
	printCustomInstruction(d);
	d.out("");
	await doctor(d);
}

async function askDenyList(d: CommandDeps): Promise<string[]> {
	const current = d.config.repos.deny_remotes;
	const answer = await d.ask(
		`Git hosts or host/path prefixes where memory must never be used (for example an employer's), comma-separated [${current.join(", ")}]:`,
		current.join(","),
	);
	return answer
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
