// `pnpm gen`: writes every generated file that is committed to the repository.
//   - packages/contracts/schema/**.json        JSON Schemas from the zod definitions
//   - packages/contracts/src/generated/policy-data.ts   secrets and stopwords from the policy
// `pnpm gen --check` writes nothing and exits 1 if any committed file is out of date. Tests run
// the same comparison (scripts/gen.test.ts), so CI fails on a stale file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { schemaFileText } from "../packages/contracts/src/json-schema.ts";
import { SCHEMA_FILES } from "../packages/contracts/src/schema-catalog.ts";
import { renderPolicyData } from "../packages/server/scripts/policy-data.ts";

export const ROOT = join(import.meta.dirname, "..");

export interface GeneratedFile {
  /** Path relative to the repository root, with forward slashes. */
  readonly path: string;
  readonly text: string;
}

export function generatedFiles(): GeneratedFile[] {
  return [
    ...SCHEMA_FILES.map((f) => ({ path: `packages/contracts/schema/${f.path}`, text: schemaFileText(f.build()) })),
    { path: "packages/contracts/src/generated/policy-data.ts", text: renderPolicyData(join(ROOT, "packages/server/policy")) },
  ];
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Generated files whose committed copy is missing or different. */
export function staleFiles(): string[] {
  return generatedFiles()
    .filter((f) => readOrNull(join(ROOT, f.path)) !== f.text)
    .map((f) => f.path);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  if (values.check) {
    const stale = staleFiles();
    for (const p of stale) console.error(`out of date: ${p}`);
    process.exitCode = stale.length > 0 ? 1 : 0;
  } else {
    for (const f of generatedFiles()) {
      const abs = join(ROOT, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.text);
    }
    console.log(`wrote ${generatedFiles().length} files`);
  }
}
