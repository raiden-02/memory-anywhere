// The server release tarball (deployment-aws.md §7.3, §7.4), built on Linux in CI:
//
//   node scripts/build-server-release.ts <version> [--out <dir>] [--arch arm64|x64]
//
// Output: <out>/memory-anywhere-server-<version>.tar.gz (default out: dist/release), laid out as
// the updater expects:
//
//   VERSION                              the version, nothing else
//   bin/memory-anywhere-server           launcher: the pinned Node runs the TypeScript sources
//   app/packages/server/{src,migrations,seed,package.json}
//   app/packages/contracts/{src,package.json}
//   app/config/{models.json,vendors.json}
//   app/node_modules/…                   production dependencies, natives prebuilt for linux-<arch>
//   app/node_modules/@memory-anywhere/contracts → ../../packages/contracts (relative symlink)
//   host/                                install.sh, units, helpers
//
// Why sources and not a bundle: the server reads its migrations, templates, seed and config next
// to its own modules. Why the symlink: Node strips types only outside node_modules, and it
// resolves a symlink to its real path, so the contracts' .ts files load from packages/. Only a
// Linux tar keeps that link (Windows tar turns links into copies), so the build refuses to run
// elsewhere. Nothing is signed here: CI signs (release.yml), or `mema deploy --release-file` does.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,32})?$/;

function run(cmd: string, args: string[], cwd = ROOT): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error?.message})`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The release's native modules must all be built for the target: no other platform's binaries load. */
function checkNatives(app: string, arch: string): void {
  const natives = walk(join(app, "node_modules")).filter((f) => f.endsWith(".node")).map((f) => relative(app, f).replaceAll("\\", "/"));
  const wanted = [
    (f: string) => f === `node_modules/onnxruntime-node/bin/napi-v6/linux/${arch}/onnxruntime_binding.node`,
    (f: string) => f.startsWith(`node_modules/argon2/prebuilds/linux-${arch}/`) && f.endsWith(".glibc.node"),
  ];
  for (const [i, w] of wanted.entries()) {
    if (!natives.some(w)) throw new Error(`missing the linux-${arch} ${i === 0 ? "onnxruntime-node" : "argon2"} binary; found: ${natives.join(", ")}`);
  }
}

function main(): void {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, arch: { type: "string", default: "arm64" } } });
  const version = positionals[0] ?? "";
  if (!VERSION.test(version)) throw new Error("usage: build-server-release.ts <version, such as 0.2.0> [--out <dir>] [--arch arm64|x64]");
  if (values.arch !== "arm64" && values.arch !== "x64") throw new Error("--arch is arm64 or x64");
  if (process.platform !== "linux") throw new Error("build the release on Linux (CI): only a Linux tar keeps the contracts symlink");
  const arch = values.arch;
  const outDir = values.out ?? join(ROOT, "dist", "release");

  const stage = mkdtempSync(join(tmpdir(), "ma-release-"));
  try {
    // Production dependencies for linux-<arch> glibc, flat (no .pnpm links), without install scripts:
    // the natives come prebuilt inside their packages (ADR-0005).
    const deployed = join(stage, "deploy");
    run("pnpm", [
      "--filter", "@memory-anywhere/server", "deploy", "--prod", "--cpu", arch, "--os", "linux", "--libc", "glibc",
      "--ignore-scripts", "--node-linker", "hoisted", deployed,
    ]);
    const app = join(stage, "app");
    const server = join(app, "packages", "server");
    mkdirSync(server, { recursive: true });
    renameSync(join(deployed, "node_modules"), join(app, "node_modules"));
    for (const entry of ["src", "migrations", "seed", "package.json"]) renameSync(join(deployed, entry), join(server, entry));

    // contracts: sources under packages/, linked from node_modules.
    const contracts = join(app, "packages", "contracts");
    mkdirSync(contracts, { recursive: true });
    cpSync(join(ROOT, "packages", "contracts", "src"), join(contracts, "src"), { recursive: true });
    cpSync(join(ROOT, "packages", "contracts", "package.json"), join(contracts, "package.json"));
    const link = join(app, "node_modules", "@memory-anywhere", "contracts");
    rmSync(link, { recursive: true, force: true });
    mkdirSync(join(app, "node_modules", "@memory-anywhere"), { recursive: true });
    symlinkSync("../../packages/contracts", link, "dir");

    mkdirSync(join(app, "config"));
    for (const f of ["models.json", "vendors.json"]) cpSync(join(ROOT, "config", f), join(app, "config", f));

    // The server reports its package version in /v1/health, which the updater compares with VERSION.
    const pkgFile = join(server, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);

    checkNatives(app, arch);
    const tests = walk(server).filter((f) => /[\\/]test[\\/]|\.test\.ts$/u.test(f));
    if (tests.length > 0) throw new Error(`tests in the release: ${tests.slice(0, 3).join(", ")}`);

    writeFileSync(join(stage, "VERSION"), `${version}\n`);
    mkdirSync(join(stage, "bin"));
    writeFileSync(
      join(stage, "bin", "memory-anywhere-server"),
      [
        "#!/bin/sh",
        "# memory-anywhere server launcher: the pinned Node (host/install.sh) runs the TypeScript sources.",
        'here=$(dirname "$(readlink -f "$0")")',
        'node=/opt/memory-anywhere/node/bin/node',
        '[ -x "$node" ] || node=node # outside an instance (the release smoke test)',
        "# On an instance every command acts on its store: the config is added unless one is given.",
        'case " $* " in *" --config "*) ;; *) [ -f /etc/memory-anywhere/server.toml ] && set -- "$@" --config /etc/memory-anywhere/server.toml ;; esac',
        'exec "$node" "$here/../app/packages/server/src/cli.ts" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    cpSync(join(ROOT, "deploy", "aws", "host", "release"), join(stage, "host"), { recursive: true });

    mkdirSync(outDir, { recursive: true });
    const tarball = join(outDir, `memory-anywhere-server-${version}.tar.gz`);
    rmSync(tarball, { force: true });
    run("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", tarball, "-C", stage, "VERSION", "bin", "app", "host"]);
    if (!existsSync(tarball)) throw new Error("tar wrote nothing");
    console.log(tarball);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
