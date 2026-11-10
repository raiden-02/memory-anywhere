// Every committed JSON Schema file under packages/contracts/schema/, and the zod schema it is
// generated from. `pnpm gen` writes them; a test fails if a committed file differs.

import type { z } from "zod";
import * as common from "./schemas/common.ts";
import { ProjectsExport } from "./schemas/export.ts";
import { TOOLS, TOOL_ORDER } from "./schemas/tools.ts";
import * as v1 from "./schemas/v1.ts";
import { toJsonSchema } from "./json-schema.ts";

export interface SchemaFile {
  /** Path relative to packages/contracts/schema/, with forward slashes. */
  readonly path: string;
  readonly build: () => Record<string, unknown>;
}

const one = (path: string, schema: z.ZodType, io: "input" | "output"): SchemaFile => ({ path, build: () => toJsonSchema(schema, io) });

const COMMON_DEFS: Record<string, z.ZodType> = {
  MemoryId: common.MemoryId,
  ObservationId: common.ObservationId,
  Kind: common.Kind,
  Outcome: common.Outcome,
  Tier: common.Tier,
  PartialDate: common.PartialDate,
  Date: common.DateString,
  Timestamp: common.Timestamp,
  ErrorCode: common.ErrorCode,
  Error: common.ErrorObject,
  RecallItem: common.RecallItem,
};

export const SCHEMA_FILES: readonly SchemaFile[] = [
  {
    path: "common.v1.json",
    build: () => ({
      $id: "https://memory-anywhere.dev/schema/common.v1.json",
      $defs: Object.fromEntries(Object.entries(COMMON_DEFS).map(([name, s]) => [name, toJsonSchema(s, "output")])),
    }),
  },
  ...TOOL_ORDER.flatMap((name) => [
    one(`tools/${name}.input.json`, TOOLS[name].input, "input"),
    one(`tools/${name}.output.json`, TOOLS[name].output, "output"),
  ]),
  one("v1/health.response.json", v1.HealthResponse, "output"),
  one("v1/session-start.request.json", v1.SessionStartRequest, "input"),
  one("v1/session-start.response.json", v1.SessionStartResponse, "output"),
  one("v1/projection.response.json", v1.ProjectionResponse, "output"),
  one("v1/entry.json", v1.Entry, "input"),
  one("v1/writes.request.json", v1.WritesRequest, "input"),
  one("v1/writes.response.json", v1.WritesResponse, "output"),
  one("v1/recall.request.json", v1.RecallRequest, "input"),
  one("v1/repos-check.request.json", v1.ReposCheckRequest, "input"),
  one("v1/repos-check.response.json", v1.ReposCheckResponse, "output"),
  one("v1/import-estimate.request.json", v1.ImportEstimateRequest, "input"),
  one("v1/import-estimate.response.json", v1.ImportEstimateResponse, "output"),
  one("v1/admin/stepup.request.json", v1.StepupRequest, "input"),
  one("v1/admin/stepup.response.json", v1.StepupResponse, "output"),
  ...Object.entries(v1.ADMIN_ARGS).map(([command, s]) => one(`v1/admin/${command}.json`, s, "input")),
  one("projects-export.v1.json", ProjectsExport, "output"),
];
