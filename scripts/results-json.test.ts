// Every committed result and evidence JSON file must parse: scrubbing once corrupted
// decimal numbers in eval results (the scrubber's account-id rule matched fraction digits).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RESULTS = join(import.meta.dirname, "..", "docs", "results");

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return jsonFiles(p);
    return name.endsWith(".json") ? [p] : [];
  });
}

describe("docs/results JSON files", () => {
  it.each(jsonFiles(RESULTS).map((f) => [f.slice(RESULTS.length + 1)]))("%s parses", (rel) => {
    expect(() => JSON.parse(readFileSync(join(RESULTS, rel), "utf8"))).not.toThrow();
  });
});
