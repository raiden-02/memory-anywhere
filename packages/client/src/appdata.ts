// Windows app-package containers (config-and-cli.md §3; clients.md §6). A packaged
// (MSIX) desktop app such as the Claude app runs its shells in a container: files they create
// under %LOCALAPPDATA% or %APPDATA% land in %LOCALAPPDATA%\Packages\<family>\LocalCache\{Local,
// Roaming} instead, and only that app sees them. A `mema login` run there signs in that app alone;
// Cursor and the owner's terminal keep reading the real AppData. Inside, the app also prefers its
// copy, so a stale one shadows later changes made from a normal terminal.
//
// No environment variable or Node API reports the container, so the test is behavioural: create a
// probe file in %LOCALAPPDATA% and see whether it appears under a package's LocalCache instead.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Paths } from "@memory-anywhere/contracts/paths";
import type { Check } from "./doctor.ts";

/** The file operations the detection needs, injected so tests can model a container on any OS. */
export interface AppDataFs {
	exists(file: string): boolean;
	/** Entry names in `dir`; [] when it cannot be read. */
	list(dir: string): readonly string[];
	write(file: string, text: string): void;
	remove(file: string): void;
}

export interface AppDataInputs {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly paths: Pick<Paths, "dataDir" | "configDir">;
	readonly fs: AppDataFs;
	/** Name of the probe file; unique per run so concurrent runs never collide. */
	readonly probeName?: string;
}

/** A package's private copy of one of our folders, and the real folder it hides. */
export interface ShadowCopy {
	readonly shadow: string;
	readonly real: string;
}

export interface AppDataView {
	/** The package family whose container this process runs in, if any. */
	readonly container: string | undefined;
	readonly copies: readonly ShadowCopy[];
}

const CLEAN: AppDataView = { container: undefined, copies: [] };
const w = path.win32;

export function detectAppDataView({
	platform,
	env,
	paths,
	fs,
	probeName = `memory-anywhere-probe-${randomUUID()}.tmp`,
}: AppDataInputs): AppDataView {
	const local = env["LOCALAPPDATA"]?.trim();
	if (platform !== "win32" || !local) return CLEAN;
	// Each of our folders that lives under AppData, with its place inside a package's LocalCache.
	const roots = [
		["Local", local],
		["Roaming", env["APPDATA"]?.trim()],
	] as const;
	const mapped = [...new Set([paths.dataDir, paths.configDir])].flatMap((real) =>
		roots.flatMap(([kind, root]) => {
			const rel = root ? w.relative(root, real) : "..";
			return rel.startsWith("..") || w.isAbsolute(rel) ? [] : [{ real, cache: w.join("LocalCache", kind, rel) }];
		}),
	);
	// MA_HOME outside AppData: nothing of ours is virtualized, so there is nothing to probe.
	if (mapped.length === 0) return CLEAN;

	const packages = w.join(local, "Packages");
	const families = fs.list(packages);
	const copies = families.flatMap((f) =>
		mapped.map((m) => ({ shadow: w.join(packages, f, m.cache), real: m.real })).filter((c) => fs.exists(c.shadow)),
	);
	return { container: probeContainer(fs, local, packages, families, probeName), copies };
}

function probeContainer(
	fs: AppDataFs,
	local: string,
	packages: string,
	families: readonly string[],
	probeName: string,
): string | undefined {
	const probe = w.join(local, probeName);
	try {
		fs.write(probe, "");
	} catch {
		return undefined;
	}
	try {
		return families.find((f) => fs.exists(w.join(packages, f, "LocalCache", "Local", probeName)));
	} finally {
		// Inside the container the delete is redirected too, so it removes the container's copy.
		try {
			fs.remove(probe);
		} catch {
			// A leftover empty probe file is harmless.
		}
	}
}

export const nodeAppDataFs: AppDataFs = {
	exists: existsSync,
	list: (dir) => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
	write: (file, text) => writeFileSync(file, text, { flag: "wx" }),
	remove: (file) => rmSync(file, { force: true }),
};

export function currentAppDataView(paths: AppDataInputs["paths"]): AppDataView {
	return detectAppDataView({ platform: process.platform, env: process.env, paths, fs: nodeAppDataFs });
}

/** `appdata.virtualized` (clients.md §6). Also printed as a warning by `connect`, `login` and `init`. */
export function appDataCheck(v: AppDataView): Check {
	const id = "appdata.virtualized";
	if (!v.container && v.copies.length === 0)
		return { id, verdict: "pass", detail: "no app package holds its own copy of the client's files" };
	const detail = v.container
		? `this shell runs inside the app package ${v.container}, so what it writes to AppData only that app sees`
		: `an app package holds its own copy of memory-anywhere's files: ${v.copies.map((c) => c.shadow).join(", ")}`;
	const moves = v.copies.map((c) => `from ${c.shadow} to ${c.real}`).join(" and ");
	const fix = [
		"Run `mema connect`, `mema login` and `mema init` from a normal terminal, not from one inside a desktop app.",
		...(moves
			? [
					`From that terminal, copy any newer files ${moves}, then delete ${v.copies.length === 1 ? "that copy" : "those copies"}.`,
				]
			: []),
	].join(" ");
	return { id, verdict: "fail", detail, fix };
}
