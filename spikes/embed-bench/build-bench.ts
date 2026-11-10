// Pack embed-bench for the spike instance (Q14 on t4g.small): code, linux-arm64 production
// dependencies, the dev queries and the PC's model hashes. Models are not packed; the instance
// downloads them from the pinned Hugging Face revisions and checks them against the hashes.
//
//   node spikes/embed-bench/build-bench.ts  ->  spikes/embed-bench/out/embed-bench-linux-arm64.tar.gz

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFlatNodeModules, run } from "../stub-server/build-release.ts";

const HERE = import.meta.dirname;
const OUT = join(HERE, "out");

const stage = mkdtempSync(join(tmpdir(), "ma bench "));
try {
  run("pnpm", ["--filter", "@memory-anywhere/spike-embed-bench", "deploy", "--prod", "--cpu", "arm64", "--os", "linux", "--libc", "glibc", "--ignore-scripts", "--node-linker", "hoisted", join(stage, "app")]);
  assertFlatNodeModules(join(stage, "app"));
  // Keep only onnxruntime-node's linux-arm64 binaries (the package carries every platform).
  const napi = join(stage, "app", "node_modules", "onnxruntime-node", "bin", "napi-v6");
  for (const os of readdirSync(napi)) {
    if (os !== "linux") rmSync(join(napi, os), { recursive: true, force: true });
  }
  for (const arch of readdirSync(join(napi, "linux"))) {
    if (arch !== "arm64") rmSync(join(napi, "linux", arch), { recursive: true, force: true });
  }
  for (const f of ["queries-dev.json"]) {
    const src = join(OUT, "cache", f);
    if (!existsSync(src)) throw new Error(`${src} missing: run bench.ts --split dev first`);
    cpSync(src, join(stage, "app", f));
  }
  cpSync(join(OUT, "models", "hashes.json"), join(stage, "app", "expected-hashes.json"));
  cpSync(join(HERE, "t4g.sh"), join(stage, "app", "t4g.sh"));
  mkdirSync(OUT, { recursive: true });
  const tarball = join(OUT, "embed-bench-linux-arm64.tar.gz");
  const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-czf", tarball, "-C", join(stage, "app"), "."]);
  console.log(`built ${tarball}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
