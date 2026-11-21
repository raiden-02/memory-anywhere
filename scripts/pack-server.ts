// `pnpm pack:server`: assembles the npm package `memory-anywhere-server` in
// dist/npm/memory-anywhere-server, ready for `npm pack` or `npm publish --provenance`. Local mode
// installs it (`mema init --local`, packages/client/src/server-install.ts); the AWS server runs the
// signed release tarball instead (scripts/build-server-release.ts).
//
//   dist/npm/memory-anywhere-server/
//     package.json          name, version, bin, the server's npm dependencies at their pinned versions
//     dist/server.mjs       the server and its contracts, bundled; npm dependencies stay imports
//     migrations/           NNNN_*.sql as they are, NNNN_*.ts data steps bundled to .mjs
//     seed/                 the sections and attributes the first migration inserts
//     web/                  the admin pages' templates and assets
//     config/               models.json (the pinned embedding model), vendors.json
//     README.md, LICENSE
//
// Why a bundle and not the TypeScript sources: Node strips types only outside node_modules, and an
// installed package lives inside it. The server finds these files next to the bundle (src/root.ts).
// Every npm dependency stays external, so its own files and prebuilt native modules load as npm
// installed them.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { ROOT } from "./build.ts";

export const SERVER_OUT = join(ROOT, "dist", "npm", "memory-anywhere-server");
const SERVER = join(ROOT, "packages", "server");

interface PackageJson {
	version: string;
	license?: string;
	engines: { node: string };
	dependencies: Record<string, string>;
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** The server's npm dependencies with their pinned versions; the workspace's own packages are bundled. */
export function serverDependencies(): Record<string, string> {
	const deps = readJson<PackageJson>(join(SERVER, "package.json")).dependencies;
	return Object.fromEntries(Object.entries(deps).filter(([name]) => !name.startsWith("@memory-anywhere/")));
}

/** The published package.json. */
export function serverPackageJson(): Record<string, unknown> {
	const server = readJson<PackageJson>(join(SERVER, "package.json"));
	const root = readJson<PackageJson>(join(ROOT, "package.json"));
	if (!root.license) throw new Error("package.json has no license: choose one before publishing");
	return {
		name: "memory-anywhere-server",
		version: server.version,
		description: "The memory-anywhere store, for local mode: installed by `mema init --local`",
		license: root.license,
		type: "module",
		bin: { "memory-anywhere-server": "dist/server.mjs" },
		files: ["dist", "migrations", "seed", "web", "config", "README.md", "LICENSE"],
		engines: root.engines,
		repository: {
			type: "git",
			url: "git+https://github.com/raiden-02/memory-anywhere.git",
			directory: "packages/server",
		},
		dependencies: serverDependencies(),
	};
}

const README = `# memory-anywhere-server

The memory-anywhere store for local mode. You do not install it yourself: \`mema init --local\`
(from the \`memory-anywhere\` package) installs the version that matches your client and starts it.

Documentation: https://github.com/raiden-02/memory-anywhere
`;

/** Bundles one entry point; every npm dependency stays an import. */
async function bundle(entry: string, outfile: string, external: string[]): Promise<void> {
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		external,
		legalComments: "none",
		logLevel: "warning",
	});
}

export async function packServer(out: string = SERVER_OUT): Promise<string> {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const external = Object.keys(serverDependencies()).flatMap((name) => [name, `${name}/*`]);

	await bundle(join(SERVER, "src", "cli.ts"), join(out, "dist", "server.mjs"), external);
	mkdirSync(join(out, "migrations"));
	for (const file of readdirSync(join(SERVER, "migrations"))) {
		const from = join(SERVER, "migrations", file);
		if (file.endsWith(".sql")) cpSync(from, join(out, "migrations", file));
		else if (file.endsWith(".ts"))
			await bundle(from, join(out, "migrations", file.replace(/\.ts$/u, ".mjs")), external);
	}
	cpSync(join(SERVER, "seed"), join(out, "seed"), { recursive: true });
	cpSync(join(SERVER, "src", "web", "templates"), join(out, "web", "templates"), { recursive: true });
	cpSync(join(SERVER, "src", "web", "assets"), join(out, "web", "assets"), { recursive: true });
	for (const file of ["models.json", "vendors.json"]) cpSync(join(ROOT, "config", file), join(out, "config", file));

	writeFileSync(join(out, "README.md"), README);
	if (existsSync(join(ROOT, "LICENSE"))) cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
	writeFileSync(join(out, "package.json"), `${JSON.stringify(serverPackageJson(), null, 2)}\n`);
	return out;
}

if (import.meta.main) console.log(`packed ${await packServer()}`);
