// Runs the Q22 checks on every CI runner (Windows, Linux x64 and arm64, macOS; Node 24 and 26).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runQ22 } from "../src/q22.ts";

describe("Q22: node:sqlite has what data-model.md needs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma q22 "));
  const checks = runQ22(dir);
  rmSync(dir, { recursive: true, force: true });

  it.each(checks.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(c.ok, c.detail).toBe(true);
  });
});
