// Project catalog export, format version 1 (data-model.md §11). career-os reads this file and
// never calls the server. Only approved project entities appear; never sensitive memories.

import { z } from "zod";
import { MemoryId, Timestamp } from "./common.ts";
import { ProjectStatus } from "./v1.ts";

const DatedItem = z.strictObject({ id: MemoryId, content: z.string().max(400), valid_from: z.string().nullable().optional() });
const ContestedValue = z.strictObject({ value: z.string(), memory_id: MemoryId });

export const ProjectsExport = z.strictObject({
  format: z.literal("memory-anywhere-projects"),
  format_version: z.literal(1),
  exported_at: Timestamp,
  projects: z.array(
    z.strictObject({
      entity_id: z.string().regex(/^ent_/),
      name: z.string(),
      aliases: z.array(z.string()),
      status: ProjectStatus.nullable(),
      goal: z.string().nullable(),
      contested_fields: z.record(z.string(), z.array(ContestedValue)),
      role: z.string().nullable(),
      repo: z.string().nullable(),
      stack: z.array(z.string()),
      decisions: z.array(DatedItem),
      constraints: z.array(DatedItem),
      outcomes: z.array(DatedItem),
      portfolio_relevance: z.array(z.string()),
      last_activity_at: Timestamp.nullable(),
    }),
  ),
});
export type ProjectsExportT = z.infer<typeof ProjectsExport>;
