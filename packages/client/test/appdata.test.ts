// The `appdata.virtualized` check (clients.md §6): a shell inside a Windows app
// package's container, and a package's leftover copy of memory-anywhere's folders. The fake file
// system models the container's redirection, so these run on every OS.

import path from "node:path";
import { resolvePaths } from "@memory-anywhere/contracts/paths";
import { describe, expect, it } from "vitest";
import { appDataCheck, detectAppDataView, type AppDataFs } from "../src/appdata.ts";

const HOME = "C:\\Users\\owner";
const LOCAL = `${HOME}\\AppData\\Local`;
const ROAMING = `${HOME}\\AppData\\Roaming`;
const ENV = { LOCALAPPDATA: LOCAL, APPDATA: ROAMING };
const PACKAGES = `${LOCAL}\\Packages`;
const APP = "Claude_abc123";
// Folders under AppData, as MA_HOME can place them: the case the check exists for.
const paths = { dataDir: `${LOCAL}\\memory-anywhere`, configDir: `${ROAMING}\\memory-anywhere` };
const SHADOW_DATA = `${PACKAGES}\\${APP}\\LocalCache\\Local\\memory-anywhere`;
const SHADOW_CONFIG = `${PACKAGES}\\${APP}\\LocalCache\\Roaming\\memory-anywhere`;

/** A file system with `existing` files; with `inside`, new files under AppData go to that package. */
function fakeFs(existing: readonly string[], inside?: string): AppDataFs & { files: Set<string> } {
	// Windows paths compare without case, but listings keep the names' own case.
	const files = new Set(existing);
	const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
	const under = (file: string, dir: string): boolean => file.toLowerCase().startsWith(`${dir.toLowerCase()}\\`);
	const redirect = (file: string): string =>
		inside && under(file, LOCAL)
			? path.win32.join(PACKAGES, inside, "LocalCache", "Local", path.win32.relative(LOCAL, file))
			: file;
	return {
		files,
		exists: (f) => [...files].some((x) => same(x, f) || under(x, f)),
		list: (dir) => [
			...new Set([...files].filter((x) => under(x, dir)).map((x) => x.slice(dir.length + 1).split("\\")[0] ?? "")),
		],
		write: (f) => void files.add(redirect(f)),
		remove: (f) => void [...files].filter((x) => same(x, redirect(f))).forEach((x) => files.delete(x)),
	};
}

const detect = (fs: AppDataFs, over: Partial<Parameters<typeof detectAppDataView>[0]> = {}) =>
	detectAppDataView({ platform: "win32", env: ENV, paths, fs, probeName: "probe.tmp", ...over });

const OTHER_PACKAGE = `${PACKAGES}\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\Settings\\settings.dat`;

describe("appdata.virtualized", () => {
	it("passes in a normal shell with no package copies", () => {
		const fs = fakeFs([`${paths.dataDir}\\tokens.json`, OTHER_PACKAGE]);
		const v = detect(fs);
		expect(v).toEqual({ container: undefined, copies: [] });
		expect(appDataCheck(v).verdict).toBe("pass");
		expect([...fs.files].some((f) => f.endsWith("probe.tmp"))).toBe(false);
	});

	it("names the package a shell runs inside, and removes its probe", () => {
		const fs = fakeFs([OTHER_PACKAGE, `${PACKAGES}\\${APP}\\Settings\\settings.dat`], APP);
		const v = detect(fs);
		expect(v.container).toBe(APP);
		expect([...fs.files].some((f) => f.endsWith("probe.tmp"))).toBe(false);
		const c = appDataCheck(v);
		expect(c.verdict).toBe("fail");
		expect(c.detail).toContain(APP);
		expect(c.fix).toContain("normal terminal");
	});

	it("finds the copies a container left, and says which way to copy them", () => {
		const fs = fakeFs([`${SHADOW_DATA}\\tokens.json`, `${SHADOW_CONFIG}\\client.toml`, OTHER_PACKAGE]);
		const v = detect(fs);
		expect(v.container).toBeUndefined();
		expect(v.copies).toEqual([
			{ shadow: SHADOW_DATA, real: paths.dataDir },
			{ shadow: SHADOW_CONFIG, real: paths.configDir },
		]);
		const c = appDataCheck(v);
		expect(c.verdict).toBe("fail");
		expect(c.fix).toContain(`from ${SHADOW_DATA} to ${paths.dataDir} and from ${SHADOW_CONFIG} to ${paths.configDir}`);
		expect(c.fix).toContain("delete those copies");
	});

	it("reports both a container and the copy it is writing", () => {
		const v = detect(fakeFs([`${SHADOW_DATA}\\tokens.json`], APP));
		expect(v).toEqual({ container: APP, copies: [{ shadow: SHADOW_DATA, real: paths.dataDir }] });
		expect(appDataCheck(v).fix).toContain("delete that copy");
	});

	it("does nothing off Windows, or when our files are outside AppData (the default, or MA_HOME)", () => {
		const fs = fakeFs([`${SHADOW_DATA}\\tokens.json`], APP);
		expect(detect(fs, { platform: "linux" })).toEqual({ container: undefined, copies: [] });
		const elsewhere = resolvePaths({ platform: "win32", env: { ...ENV, MA_HOME: "D:\\ma" }, home: HOME });
		expect(detect(fs, { paths: elsewhere })).toEqual({ container: undefined, copies: [] });
		expect(detect(fs, { paths: resolvePaths({ platform: "win32", env: ENV, home: HOME }) })).toEqual({
			container: undefined,
			copies: [],
		});
		expect(fs.files.size).toBe(1);
	});

	it("treats a probe it cannot write as no container", () => {
		const fs = {
			...fakeFs([]),
			write: () => {
				throw new Error("EACCES");
			},
		};
		expect(detect(fs).container).toBeUndefined();
	});
});
