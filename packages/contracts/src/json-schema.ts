// JSON Schema generation from the zod definitions. The output is what the committed files in
// packages/contracts/schema/ hold and what the MCP server advertises in `tools/list`.
//
// Every schema is self-contained and Gemini-safe (spec-issues #25, ADR-0107): no `$schema`,
// no `$ref`, no empty `properties`. Generation also removes zod details that are not part of the
// spec's schemas: the long regex zod attaches to `format: date-time`, and the safe-integer bounds
// it adds to every integer.

import { z } from "zod";

type JsonObject = Record<string, unknown>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function tidy(node: JsonObject): void {
  if (node["format"] === "date-time") delete node["pattern"];
  if (node["type"] === "integer") {
    if (node["maximum"] === MAX_SAFE) delete node["maximum"];
    if (node["minimum"] === -MAX_SAFE) delete node["minimum"];
  }
  if (node["x-exclusive"] === true) {
    // A union whose branches can never both match: `oneOf` says so precisely.
    node["oneOf"] = node["anyOf"];
    delete node["anyOf"];
    delete node["x-exclusive"];
  }
  // `additionalProperties: {}` (anything allowed) is the default; the spec writes just `{"type":"object"}`.
  const extra = node["additionalProperties"];
  if (extra && typeof extra === "object" && Object.keys(extra).length === 0) delete node["additionalProperties"];
  const props = node["properties"];
  if (node["type"] === "object" && props && typeof props === "object" && Object.keys(props).length === 0) {
    delete node["properties"];
  }
}

function walk(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(walk);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as JsonObject;
    for (const v of Object.values(obj)) walk(v);
    tidy(obj);
  }
}

/**
 * JSON Schema for a zod schema. `io: "input"` describes what a caller may send (fields with a
 * default are optional); `io: "output"` describes what the server returns.
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const out = z.toJSONSchema(schema, { io, target: "draft-2020-12", reused: "inline", unrepresentable: "throw" }) as JsonObject;
  delete out["$schema"];
  walk(out);
  return out;
}

/** Stable text for a schema file: two-space indent, trailing newline. */
export function schemaFileText(schema: JsonObject): string {
  return JSON.stringify(schema, null, 2) + "\n";
}
