import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT } from "./build.ts";
import { packServer, serverDependencies } from "./pack-server.ts";

const dir = mkdtempSync(join(tmpdir(), "ma pack server "));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the memory-anywhere-server npm package", () => {
	it("runs from its bundle: migrates a new store with the bundled data step and seeds", async () => {
		const out = await packServer(join(dir, "package"));
		// What npm would install next to it: the server's own dependencies, borrowed from the workspace.
		symlinkSync(join(ROOT, "packages", "server", "node_modules"), join(out, "node_modules"), "junction");
		const data = join(dir, "data");
		mkdirSync(data);
		const config = join(dir, "server.toml");
		const q = JSON.stringify;
		writeFileSync(
			config,
			`schema = 1\n\n[server]\nmode = "local"\nlisten = "127.0.0.1:47999"\ndata_dir = ${q(data)}\nlocal_token_file = ${q(join(data, "local.token"))}\nmodels_dir = ${q(join(dir, "models"))}\n`,
		);
		const server = (...args: string[]) =>
			execFileSync(process.execPath, [join(out, "dist", "server.mjs"), ...args], { encoding: "utf8" });

		const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { version: string };
		expect(JSON.parse(server("version"))).toMatchObject({ server: pkg.version });
		expect(JSON.parse(server("migrate", "--config", config))).toMatchObject({ from: 0 });
		const db = new DatabaseSync(join(data, "store.db"));
		try {
			expect((db.prepare("SELECT count(*) AS n FROM section").get() as { n: number }).n).toBeGreaterThan(0);
			expect((db.prepare("SELECT count(*) AS n FROM attribute").get() as { n: number }).n).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	}, 120_000);

	it("depends on npm packages only, at the server's pinned versions", () => {
		const deps = serverDependencies();
		expect(Object.keys(deps).some((name) => name.startsWith("@memory-anywhere/"))).toBe(false);
		for (const version of Object.values(deps)) expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
	});
});
