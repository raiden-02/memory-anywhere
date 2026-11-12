// Contract test: the JSON Schemas generated from zod say exactly what mcp-interface.md says.
// The spec's JSON blocks are the source (mcp-interface.md, opening paragraph). They are compared
// after the Gemini-safe rewrites of spec-issues #25: `$ref`s inlined, `$id` removed, and an empty
// `properties` object dropped. Key order and `required` order do not matter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toJsonSchema } from "../src/json-schema.ts";
import { TOOLS } from "../src/schemas/tools.ts";
import { Entry } from "../src/schemas/v1.ts";

type Json = unknown;

const SPEC = readFileSync(join(import.meta.dirname, "../../../docs/spec/mcp-interface.md"), "utf8");
const BLOCKS: Json[] = [...SPEC.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] ?? "null"));

const COMMON = BLOCKS[0] as { $defs: Record<string, Json> };

function inline(node: Json): Json {
  if (Array.isArray(node)) return node.map(inline);
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, Json>;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    const name = ref.replace(/^(?:common\.v1\.json)?#\/\$defs\//, "");
    const target = COMMON.$defs[name];
    if (target === undefined) throw new Error(`unknown $ref ${ref}`);
    return inline(target);
  }
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$id") continue;
    out[k] = inline(v);
  }
  const props = out["properties"];
  if (out["type"] === "object" && props && typeof props === "object" && Object.keys(props).length === 0) delete out["properties"];
  return out;
}

/** Sorted keys and sorted `required`, so equality ignores ordering. */
function canonical(node: Json): Json {
  if (Array.isArray(node)) return node.map(canonical);
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    out[k] = k === "required" && Array.isArray(v) ? [...v].sort() : canonical(v);
  }
  return out;
}

const spec = (i: number) => canonical(inline(BLOCKS[i]));
const ours = (s: Parameters<typeof toJsonSchema>[0], io: "input" | "output") => canonical(toJsonSchema(s, io));
const EMPTY_INPUT = { additionalProperties: false, type: "object" };

describe("generated JSON Schemas match mcp-interface.md", () => {
  it("finds the ten schema blocks", () => expect(BLOCKS).toHaveLength(10));

  it.each([
    ["memory_recall input", () => ours(TOOLS.memory_recall.input, "input"), 1],
    ["memory_recall output", () => ours(TOOLS.memory_recall.output, "output"), 2],
    ["memory_profile output", () => ours(TOOLS.memory_profile.output, "output"), 3],
    ["memory_save input", () => ours(TOOLS.memory_save.input, "input"), 4],
    ["memory_save output", () => ours(TOOLS.memory_save.output, "output"), 5],
    ["memory_forget input", () => ours(TOOLS.memory_forget.input, "input"), 6],
    ["memory_forget output", () => ours(TOOLS.memory_forget.output, "output"), 7],
    ["memory_status output", () => ours(TOOLS.memory_status.output, "output"), 8],
    ["/v1/writes Entry", () => ours(Entry, "input"), 9],
  ] as const)("%s", (_name, generated, block) => {
    expect(generated()).toEqual(spec(block));
  });

  it("empty inputs are a bare closed object, as Gemini requires", () => {
    expect(ours(TOOLS.memory_profile.input, "input")).toEqual(EMPTY_INPUT);
    expect(ours(TOOLS.memory_status.input, "input")).toEqual(EMPTY_INPUT);
  });

  it("no generated tool schema contains $schema, $ref or an empty properties object", () => {
    for (const t of Object.values(TOOLS)) {
      for (const s of [toJsonSchema(t.input, "input"), toJsonSchema(t.output, "output")]) {
        const text = JSON.stringify(s);
        expect(text).not.toContain("$schema");
        expect(text).not.toContain("$ref");
        expect(text).not.toContain('"properties":{}');
      }
    }
  });
});
