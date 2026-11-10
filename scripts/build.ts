// `pnpm build`: bundles the client into one pure-JS file and puts a copy in each plugin.
//
//   packages/client/src/cli.ts ──esbuild──► packages/client/dist/memory-anywhere.mjs
//                                             ├─► plugins/claude-code/dist/memory-anywhere.mjs
//                                             └─► plugins/cursor/dist/memory-anywhere.mjs
//
// The bundle has no native modules (config-and-cli.md §2), so a coding tool can run it with
// any Node ≥ 22. The dist/ folders are build output and are not committed.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

export const ROOT = join(import.meta.dirname, "..");
export const BUNDLE = join(ROOT, "packages", "client", "dist", "memory-anywhere.mjs");
export const PLUGIN_BUNDLES = ["claude-code", "cursor"].map((p) => join(ROOT, "plugins", p, "dist", "memory-anywhere.mjs"));

export async function buildClient(): Promise<void> {
  await build({
    entryPoints: [join(ROOT, "packages", "client", "src", "cli.ts")],
    outfile: BUNDLE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Bundled CommonJS dependencies may call require(); give them one.
    banner: { js: "import { createRequire as __maCreateRequire } from 'node:module'; const require = __maCreateRequire(import.meta.url);" },
    legalComments: "none",
    logLevel: "warning",
  });
  for (const target of PLUGIN_BUNDLES) {
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(BUNDLE, target);
  }
}

if (import.meta.main) {
  await buildClient();
  console.log(`built ${BUNDLE}`);
}
