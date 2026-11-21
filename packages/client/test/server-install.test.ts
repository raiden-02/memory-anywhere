import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaths } from "@memory-anywhere/contracts/paths";
import {
	installedServerCli,
	installServer,
	npmCommand,
	npmInstallArgs,
	removeOtherVersions,
	serverAppDir,
	type Run,
} from "../src/server-install.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = (): string => {
	const d = mkdtempSync(path.join(tmpdir(), "ma server install "));
	dirs.push(d);
	return d;
};

describe("installing the local server from npm", () => {
	it("installs exactly the client's version, with no install scripts, into a folder per version", () => {
		const appDir = path.join(temp(), "app", "0.5.0");
		expect(npmInstallArgs(appDir, "0.5.0", undefined)).toEqual([
			"install",
			"--prefix",
			appDir,
			"--omit=dev",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--save-exact",
			"memory-anywhere-server@0.5.0",
		]);
		expect(npmInstallArgs(appDir, "0.5.0", "server.tgz").at(-1)).toBe(path.resolve("server.tgz"));
		const calls: string[][] = [];
		const run: Run = (command, args) => {
			calls.push([command, ...args]);
			const cli = installedServerCli(appDir);
			mkdirSync(path.dirname(cli), { recursive: true });
			writeFileSync(cli, "");
			return { status: 0, stdout: "", stderr: "" };
		};
		const npm = { command: "node", prefix: ["npm-cli.js"] };
		expect(installServer(appDir, "0.5.0", run, npm)).toBe(installedServerCli(appDir));
		expect(calls).toEqual([["node", "npm-cli.js", ...npmInstallArgs(appDir, "0.5.0", undefined)]]);
		// Already installed: npm is not run again.
		installServer(appDir, "0.5.0", run, npm);
		expect(calls).toHaveLength(1);
	});

	it("says what npm reported when the install fails", () => {
		const run: Run = () => ({ status: 1, stdout: "", stderr: "npm error 404 Not Found" });
		expect(() =>
			installServer(path.join(temp(), "app", "9.9.9"), "9.9.9", run, { command: "node", prefix: [] }),
		).toThrow(/memory-anywhere-server@9\.9\.9: npm error 404 Not Found/u);
	});

	it("runs npm's own script next to Node, with no shell", () => {
		const execPath = path.join("C:", "Program Files", "nodejs", "node.exe");
		const cli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
		expect(npmCommand(execPath, (p) => p === cli)).toEqual({ command: execPath, prefix: [cli] });
	});

	it("removes the other versions' folders and keeps the running one", () => {
		const platform = process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
		const paths = resolvePaths({ home: temp(), platform, env: {} });
		for (const v of ["0.4.1", "0.5.0"]) mkdirSync(serverAppDir(paths, v), { recursive: true });
		removeOtherVersions(paths, "0.5.0");
		expect(existsSync(serverAppDir(paths, "0.4.1"))).toBe(false);
		expect(existsSync(serverAppDir(paths, "0.5.0"))).toBe(true);
	});
});
