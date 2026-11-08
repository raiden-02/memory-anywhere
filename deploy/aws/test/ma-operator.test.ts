// ma-operator.sh runs in CloudShell; these tests cover only the argument checks,
// which exit before any AWS call, so they run anywhere bash exists.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOY_AWS_DIR } from "../lib/inputs.ts";

const SCRIPT = join(DEPLOY_AWS_DIR, "ma-operator.sh");

/** Git for Windows' bash; on Windows `bash` on PATH may be WSL's, which cannot see this path. */
function findBash(): string | undefined {
  if (process.platform !== "win32") return "bash";
  const git = spawnSync("where", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0]?.trim();
  if (!git) return undefined;
  const candidate = join(dirname(dirname(git)), "bin", "bash.exe");
  return existsSync(candidate) ? candidate : undefined;
}

const bash = findBash();

function run(...args: string[]) {
  const r = spawnSync(bash ?? "bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, AWS_REGION: "us-east-1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!bash)("ma-operator.sh arguments", () => {
  it("prints usage for --help and lists all seven commands", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    for (const c of ["setup-link", "set-llm-key", "restore", "reset-owner", "acme-account", "import-export", "delete-data"]) {
      expect(r.out).toContain(c);
    }
  });

  it("rejects an unknown command", () => {
    const r = run("launch-missiles");
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown command launch-missiles");
  });

  it("rejects a malformed stage", () => {
    const r = run("setup-link", "--stage", "Prod");
    expect(r.code).toBe(1);
    expect(r.err).toContain("stage must be prod, spike or eval-<id>");
  });

  it("refuses delete-data without an explicit stage", () => {
    const r = run("delete-data");
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs an explicit --stage");
  });

  it("rejects an unknown flag", () => {
    const r = run("acme-account", "--force");
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown argument --force");
  });
});
