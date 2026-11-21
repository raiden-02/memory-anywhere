// `pnpm pack:client`: assembles the npm package `memory-anywhere` (config-and-cli.md §1) in
// dist/npm/memory-anywhere, ready for `npm pack` or `npm publish --provenance`.
//
//   dist/npm/memory-anywhere/
//     package.json            name, version, bins, and the CDK as plain dependencies (pure JS)
//     bin/memory-anywhere.mjs the client bundle (scripts/build.ts): bins `mema` and `memory-anywhere`
//     deploy/app.mjs          the CDK app, bundled; aws-cdk-lib and constructs stay dependencies,
//                             because aws-cdk-lib loads helper files from its own folder
//     deploy/cdk.json, host/, release-keys/   what the app and `mema deploy aws` read
//     plugins/claude-code, plugins/cursor      copied into the coding tools by `mema init`
//     README.md, LICENSE
//
// The workspace packages stay private; nothing here depends on them at run time.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { buildClient, BUNDLE, ROOT } from "./build.ts";

export const OUT = join(ROOT, "dist", "npm", "memory-anywhere");
const DEPLOY = join(ROOT, "deploy", "aws");
const PLUGINS = ["claude-code", "cursor"] as const;

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** The published package.json: the client's version, the CDK's pinned versions, the repository's licence. */
export function packageJson(): Record<string, unknown> {
	const client = readJson<{ version: string }>(join(ROOT, "packages", "client", "package.json"));
	const deploy = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>(
		join(DEPLOY, "package.json"),
	);
	const root = readJson<{ license?: string; engines: { node: string } }>(join(ROOT, "package.json"));
	if (!root.license) throw new Error("package.json has no license: choose one before publishing");
	return {
		name: "memory-anywhere",
		version: client.version,
		description: "One personal memory that all your AI apps share",
		license: root.license,
		type: "module",
		bin: { mema: "bin/memory-anywhere.mjs", "memory-anywhere": "bin/memory-anywhere.mjs" },
		files: ["bin", "deploy", "plugins", "README.md", "LICENSE"],
		engines: root.engines,
		repository: { type: "git", url: "git+https://github.com/raiden-02/memory-anywhere.git" },
		dependencies: {
			"aws-cdk": deploy.devDependencies["aws-cdk"],
			"aws-cdk-lib": deploy.dependencies["aws-cdk-lib"],
			constructs: deploy.dependencies["constructs"],
		},
	};
}

const REPO_BLOB = "https://github.com/raiden-02/memory-anywhere/blob/main/";

/** The README as npm shows it: its relative links point into the repository on GitHub. */
export function npmReadme(markdown: string): string {
	return markdown.replaceAll(
		/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/giu,
		(_, target: string) => `](${REPO_BLOB}${target})`,
	);
}

export async function packClient(): Promise<string> {
	await buildClient();
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(join(OUT, "bin"), { recursive: true });
	cpSync(BUNDLE, join(OUT, "bin", "memory-anywhere.mjs"));

	await build({
		entryPoints: [join(DEPLOY, "bin", "app.ts")],
		outfile: join(OUT, "deploy", "app.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["aws-cdk-lib", "aws-cdk-lib/*", "constructs"],
		legalComments: "none",
		logLevel: "warning",
	});
	for (const part of ["cdk.json", "host", "release-keys"])
		cpSync(join(DEPLOY, part), join(OUT, "deploy", part), { recursive: true });
	for (const p of PLUGINS) cpSync(join(ROOT, "plugins", p), join(OUT, "plugins", p), { recursive: true });

	writeFileSync(join(OUT, "README.md"), npmReadme(readFileSync(join(ROOT, "README.md"), "utf8")));
	if (existsSync(join(ROOT, "LICENSE"))) cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
	writeFileSync(join(OUT, "package.json"), `${JSON.stringify(packageJson(), null, 2)}\n`);
	return OUT;
}

if (import.meta.main) console.log(`packed ${await packClient()}`);
