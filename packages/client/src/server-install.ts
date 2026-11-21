// Local mode from the npm package: the server is its own npm package, `memory-anywhere-server`, at
// exactly this client's version (scripts/pack-server.ts builds it). `mema init --local` installs it
// with npm into a folder of its own per version:
//
//   {data}/server/app/<version>/node_modules/memory-anywhere-server/dist/server.mjs
//
// One folder per version, because Windows cannot replace the native modules of a server that is
// running: the new version installs beside the old one, the old one stops, and its folder goes once
// the new server answers. Re-running `mema init --local` after updating the client is the upgrade.
// npm runs with --ignore-scripts: the native dependencies ship prebuilt, so no install script runs.
// MA_SERVER_TARBALL names a packed server (.tgz) to install instead of the registry's, so a release
// can be tested on a clean machine before it is published.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { resolveTool, runCommand, type ToolResult } from "./tool-runner.ts";

export const SERVER_PACKAGE = "memory-anywhere-server";

/** Where one version of the server is installed. */
export const serverAppDir = (paths: Paths, version: string): string =>
	path.join(paths.localServerDataDir, "app", version);

/** The server's entry point inside an install folder. */
export const installedServerCli = (appDir: string): string =>
	path.join(appDir, "node_modules", SERVER_PACKAGE, "dist", "server.mjs");

/** npm's arguments to install exactly `version`, with no install scripts and nothing but the server. */
export const npmInstallArgs = (
	appDir: string,
	version: string,
	tarball: string | undefined = process.env["MA_SERVER_TARBALL"],
): string[] => [
	"install",
	"--prefix",
	appDir,
	"--omit=dev",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
	"--save-exact",
	tarball ? path.resolve(tarball) : `${SERVER_PACKAGE}@${version}`,
];

/**
 * How to run npm: its JavaScript entry next to this Node (so no `.cmd` shim or shell is involved),
 * or the `npm` on the PATH.
 */
export function npmCommand(
	execPath: string = process.execPath,
	exists: (p: string) => boolean = existsSync,
): { command: string; prefix: string[] } | undefined {
	const bin = path.dirname(execPath);
	for (const cli of [
		path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
		path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	])
		if (exists(cli)) return { command: execPath, prefix: [cli] };
	return resolveTool("npm");
}

export type Run = (command: string, args: readonly string[]) => ToolResult;

/** Installs `version` unless it is already there; returns its entry point. */
export function installServer(
	appDir: string,
	version: string,
	run: Run = (c, a) => runCommand(c, a, { timeoutMs: 600_000 }),
	npm = npmCommand(),
): string {
	const cli = installedServerCli(appDir);
	if (existsSync(cli)) return cli;
	if (!npm) throw new Error("npm was not found next to Node or on the PATH; install Node 24 with npm");
	mkdirSync(appDir, { recursive: true });
	const r = run(npm.command, [...npm.prefix, ...npmInstallArgs(appDir, version)]);
	if (r.status !== 0 || !existsSync(cli))
		throw new Error(
			`npm could not install ${SERVER_PACKAGE}@${version}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`,
		);
	return cli;
}

/** Removes the install folders of every other version; one still in use is left for next time. */
export function removeOtherVersions(paths: Paths, keep: string): void {
	const apps = path.join(paths.localServerDataDir, "app");
	if (!existsSync(apps)) return;
	for (const version of readdirSync(apps)) {
		if (version === keep) continue;
		try {
			rmSync(path.join(apps, version), { recursive: true, force: true });
		} catch {
			// A file still open on Windows: the next init removes it.
		}
	}
}
