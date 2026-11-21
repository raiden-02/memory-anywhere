import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { packagedCdkJson } from "@memory-anywhere/deploy-aws/dir";
import { sourcesFor } from "../src/init.ts";
import { packagedSources } from "../src/package-root.ts";

const ROOT = path.resolve("/pkg/memory-anywhere");
const bundleUrl = pathToFileURL(path.join(ROOT, "bin", "memory-anywhere.mjs")).href;

describe("running from the installed package", () => {
	it("finds the plugins and the bundle beside bin/", () => {
		const sources = packagedSources(bundleUrl, () => true);
		expect(sources).toEqual({
			pluginsDir: path.join(ROOT, "plugins"),
			bundle: path.join(ROOT, "bin", "memory-anywhere.mjs"),
		});
	});

	it("is not the package when the plugins are missing, as in a checkout or a plugin's own copy", () => {
		expect(packagedSources(bundleUrl, (p) => !p.endsWith("claude-code"))).toBeUndefined();
	});

	it("points an install's CDK at the bundled app and keeps the checkout's feature flags", () => {
		const json = JSON.parse(
			packagedCdkJson({ "@aws-cdk/core:flag": true }, "C:\\Program Files\\node.exe", "C:\\pkg\\deploy\\app.mjs"),
		) as Record<string, unknown>;
		expect(json).toEqual({
			app: '"C:\\Program Files\\node.exe" "C:\\pkg\\deploy\\app.mjs"',
			output: "cdk.out",
			context: { "@aws-cdk/core:flag": true },
		});
	});
});

describe("where mema init takes its files from", () => {
	const options = { local: false, fromWorkspace: undefined, clients: undefined, dryRun: true, yes: true };
	const packaged = { pluginsDir: "/pkg/plugins", bundle: "/pkg/bin/memory-anywhere.mjs" };

	it("uses the installed package when no checkout is given", () => {
		expect(sourcesFor(options, packaged)).toEqual({ kind: "package", ...packaged });
	});

	it("says how to install when it runs neither from the package nor with a checkout", () => {
		expect(() => sourcesFor(options, undefined)).toThrow(/npm i -g memory-anywhere/u);
	});

	it("sets up local mode from the package too: the server package is installed beside it", () => {
		expect(sourcesFor({ ...options, local: true }, packaged)).toEqual({ kind: "package", ...packaged });
	});
});
