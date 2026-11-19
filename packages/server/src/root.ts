// Where the server finds the files it reads next to its code. The same code runs as TypeScript
// sources (a checkout, the release tarball) and as the npm package's bundle:
//
//   sources                                   npm package memory-anywhere-server
//   packages/server/          ◄── root        <package>/                 ◄── root
//     src/root.ts   (this module)               dist/server.mjs  (bundle: this module inside)
//     src/web/{templates,assets}                web/{templates,assets}
//     migrations/, package.json                 migrations/, package.json
//   config/ (repository root)                   config/
//
// In both, the parent of this module's folder is the root.

import { existsSync } from "node:fs";
import { join } from "node:path";

export const SERVER_ROOT = join(import.meta.dirname, "..");
const PACKAGED = existsSync(join(SERVER_ROOT, "dist", "server.mjs"));

export const SERVER_PACKAGE_JSON = join(SERVER_ROOT, "package.json");
export const MIGRATIONS_DIR = join(SERVER_ROOT, "migrations");
/** models.json and vendors.json, shared with the client and the evals in a checkout. */
export const CONFIG_DIR = PACKAGED ? join(SERVER_ROOT, "config") : join(SERVER_ROOT, "..", "..", "config");
/** The admin UI's templates and assets. */
export const WEB_DIR = PACKAGED ? join(SERVER_ROOT, "web") : join(SERVER_ROOT, "src", "web");
