// Build the stub's linux-arm64 release tarball for the spike stack
// (deployment-aws.md §7.3 layout). Runs on the PC (Windows included):
//
//   node spikes/stub-server/build-release.ts <version>
//
// Output: spikes/stub-server/out/memory-anywhere-server-<version>-linux-arm64.tar.gz
// (signed later by `mema deploy aws --release-file`, never here).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
const HOST_RELEASE = join(ROOT, "deploy", "aws", "host", "release");
const PROBE_DIR = join(ROOT, "spikes", "litestream-probe");
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** On Windows, pnpm is either pnpm.exe (spawned directly) or a .cmd shim (needs cmd.exe). */
function windowsPnpm(): { exe: string } | { shim: string } {
  const found = spawnSync("where", ["pnpm"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
  const exe = found.find((p) => p.toLowerCase().endsWith(".exe"));
  if (exe) return { exe };
  const shim = found.find((p) => p.toLowerCase().endsWith(".cmd"));
  if (!shim) throw new Error("pnpm not found on PATH");
  return { shim };
}

export function run(cmd: string, args: string[], cwd = ROOT): void {
  let command = cmd;
  let argv = args;
  if (process.platform === "win32" && cmd === "pnpm") {
    const p = windowsPnpm();
    if ("exe" in p) {
      command = p.exe;
    } else {
      // cmd.exe joins arguments with spaces: quote the ones with spaces (paths here never contain quotes).
      command = process.env["ComSpec"] ?? "cmd.exe";
      argv = ["/d", "/s", "/c", [p.shim, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")];
    }
  }
  const r = spawnSync(command, argv, { cwd, stdio: "inherit", windowsVerbatimArguments: argv[0] === "/d" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error?.message})`);
}

export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main(): void {
  const version = process.argv[2] ?? "";
  if (!VERSION.test(version)) throw new Error("usage: build-release.ts <version>, for example 0.0.1-m0.1");

  const stage = mkdtempSync(join(tmpdir(), "ma release "));
  try {
    // App and production dependencies for linux-arm64 glibc, without lifecycle scripts.
    run("pnpm", [
      "--filter",
      "@memory-anywhere/spike-stub-server",
      "deploy",
      "--prod",
      "--cpu",
      "arm64",
      "--os",
      "linux",
      "--libc",
      "glibc",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      join(stage, "app"),
    ]);
    // The stub is pure JavaScript; a native module would need an arm64 build check.
    const natives = walk(join(stage, "app")).filter((f) => f.endsWith(".node"));
    if (natives.length) throw new Error(`unexpected native modules: ${natives.map((f) => relative(stage, f)).join(", ")}`);

    writeFileSync(join(stage, "VERSION"), `${version}\n`);
    mkdirSync(join(stage, "bin"));
    writeFileSync(
      join(stage, "bin", "memory-anywhere-server"),
      [
        "#!/bin/sh",
        "# M0 stub launcher: the pinned Node from host/install.sh runs the TypeScript sources directly.",
        'here=$(dirname "$(readlink -f "$0")")',
        'exec /opt/memory-anywhere/node/bin/node "$here/../app/src/main.ts" "$@"',
        "",
      ].join("\n"),
    );
    cpSync(HOST_RELEASE, join(stage, "host"), { recursive: true });
    // M0 only: the Litestream probe stands in for the server store in Q21 (deployment-aws.md §9).
    mkdirSync(join(stage, "probe"));
    cpSync(join(PROBE_DIR, "src", "probe.ts"), join(stage, "probe", "probe.ts"));
    cpSync(join(PROBE_DIR, "q21.sh"), join(stage, "probe", "q21.sh"));

    const outDir = join(HERE, "out");
    mkdirSync(outDir, { recursive: true });
    const tarball = join(outDir, `memory-anywhere-server-${version}-linux-arm64.tar.gz`);
    if (existsSync(tarball)) rmSync(tarball);
    // bsdtar (Windows) and GNU tar both accept this; entries are relative to the release root.
    // On Windows, use the system bsdtar: a GNU tar from Git Bash on PATH reads "C:\..." as a remote host.
    const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    run(tar, ["-czf", tarball, "-C", stage, "VERSION", "bin", "app", "host", "probe"]);
    console.log(`built ${tarball}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
