// Finds a bash that can run the deploy scripts in tests, or undefined (the tests then skip).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Git for Windows' bash; on Windows `bash` on PATH may be WSL's, which cannot see these paths.
 * `where git` may list `Git\mingw64\bin\git.exe` before `Git\cmd\git.exe`, so each is tried.
 */
export function findBash(): string | undefined {
	if (process.platform !== "win32") return "bash";
	const gits = spawnSync("where", ["git"], { encoding: "utf8" })
		.stdout.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	for (const git of gits) {
		const root = git.replace(/\\(mingw64\\bin|cmd|bin)\\git\.exe$/iu, "");
		const candidate = join(root, "bin", "bash.exe");
		if (root !== git && existsSync(candidate)) return candidate;
	}
	return undefined;
}
