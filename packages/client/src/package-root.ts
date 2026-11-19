// What an installed npm package `memory-anywhere` carries for `mema init` (config-and-cli.md §1;
// scripts/pack.ts builds it):
//
//   <package>/bin/memory-anywhere.mjs   ◄── this module runs inside this bundle
//   <package>/plugins/claude-code, plugins/cursor
//
// From a repository checkout (TypeScript under packages/client/src) there is no such package, and
// `mema init --from-workspace <path>` builds the same files from the checkout instead.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallSources {
	/** Folder holding claude-code/ and cursor/, copied into the coding tools. */
	readonly pluginsDir: string;
	/** The client bundle the Codex plugin and the stable bin path run. */
	readonly bundle: string;
}

/** The installed package's plugins and bundle, or undefined when not running from the package. */
export function packagedSources(
	moduleUrl: string = import.meta.url,
	exists: (p: string) => boolean = existsSync,
): InstallSources | undefined {
	const root = join(dirname(fileURLToPath(moduleUrl)), "..");
	const sources = { pluginsDir: join(root, "plugins"), bundle: join(root, "bin", "memory-anywhere.mjs") };
	return exists(join(sources.pluginsDir, "claude-code")) && exists(sources.bundle) ? sources : undefined;
}
