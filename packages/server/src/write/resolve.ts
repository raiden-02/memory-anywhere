// Step 6, deterministic part (write-path.md §6.1; memory-policy.md §9.1): which entity, attribute
// and section a save belongs to. Runs before the decision table, which needs it (rows D3, D16,
// D17), and its result is passed on unchanged to the store rules. Nothing is created here; a new
// entity is created only when something is stored.

import type { DatabaseSync } from "node:sqlite";
import { norm, normEntity } from "@memory-anywhere/contracts/normalize";
import { ATTRIBUTE_PATTERNS } from "../policy/generated.ts";
import { SELF_ENTITY_ID } from "../store/init.ts";
import type { AttributeRow, EntityType, Resolution } from "./types.ts";
import { prepared } from "../store/db.ts";

export const SECTION = {
  people: "sec_people",
  projects: "sec_projects",
  interests: "sec_interests",
  unsorted: "sec_unsorted",
} as const;

const PATTERNS = ATTRIBUTE_PATTERNS.map((p) => ({ attribute: p.attribute, re: new RegExp(p.pattern, "u") }));

interface Registry {
  readonly attributes: readonly (AttributeRow & { readonly keys: readonly string[] })[];
  readonly sections: readonly { readonly id: string; readonly keys: readonly string[] }[];
}

/** Attributes and active sections, each with its normalized name and aliases. */
export function loadRegistry(db: DatabaseSync): Registry {
  const attributes = (prepared(db, "SELECT * FROM attribute").all() as unknown as (AttributeRow & { aliases_json: string })[]).map((a) => ({
    ...a,
    keys: [a.name, ...(JSON.parse(a.aliases_json) as string[])].map(norm),
  }));
  const sections = (prepared(db, "SELECT id, name, aliases_json FROM section WHERE status = 'active'").all() as {
    id: string; name: string; aliases_json: string;
  }[]).map((s) => ({ id: s.id, keys: [s.name, ...(JSON.parse(s.aliases_json) as string[])].map(norm) }));
  return { attributes, sections };
}

interface EntityRow {
  readonly id: string;
  readonly type: EntityType;
  readonly merged_into: string | null;
}

/** An approved alias, following merges, or undefined if the entity is new. */
function findEntity(db: DatabaseSync, name: string): EntityRow | undefined {
  let row = prepared(db, 
      `SELECT e.id, e.type, e.merged_into FROM entity_alias a JOIN entity e ON e.id = a.entity_id
       WHERE a.alias_norm = ? AND a.approved = 1 ORDER BY e.created_at, e.id LIMIT 1`,
    )
    .get(normEntity(name)) as EntityRow | undefined;
  for (let hops = 0; row?.merged_into && hops < 10; hops++) {
    row = prepared(db, "SELECT id, type, merged_into FROM entity WHERE id = ?").get(row.merged_into) as EntityRow | undefined;
  }
  return row;
}

const typeFits = (attr: AttributeRow, type: EntityType | undefined): boolean =>
  attr.entity_type === "any" || type === undefined || attr.entity_type === type;

export interface ResolveInput {
  readonly content: string;
  readonly entity: string;
  readonly attribute?: string | undefined;
  readonly section?: string | undefined;
}

export function resolve(db: DatabaseSync, registry: Registry, input: ResolveInput): Resolution {
  // 1. Existing entity.
  const named = normEntity(input.entity);
  const existing = named === "" || named === "self" ? { id: SELF_ENTITY_ID, type: "self" as const, merged_into: null } : findEntity(db, input.entity);
  const existingType = existing?.type;

  const hintSection = input.section ? registry.sections.find((s) => s.keys.includes(norm(input.section ?? "")))?.id : undefined;

  // 2. Attribute: the hint, then the deterministic patterns; both must fit the entity's type.
  const hint = input.attribute ? norm(input.attribute) : undefined;
  let attribute: AttributeRow | undefined = hint
    ? registry.attributes.find((a) => a.keys.includes(hint) && typeFits(a, existingType))
    : undefined;
  if (!attribute) {
    const normalized = norm(input.content);
    const hit = PATTERNS.find((p) => p.re.test(normalized));
    const candidate = hit ? registry.attributes.find((a) => a.name === hit.attribute) : undefined;
    if (candidate && typeFits(candidate, existingType)) attribute = candidate;
  }

  // 3. Type of a new entity.
  let type: EntityType;
  if (existing) type = existing.type;
  else if (attribute && attribute.entity_type !== "self" && attribute.entity_type !== "any") type = attribute.entity_type;
  else if (hintSection === SECTION.people) type = "person";
  else if (hintSection === SECTION.projects) type = "project";
  else type = "thing";

  // 4. Re-check: an attribute of another type is dropped.
  if (attribute && attribute.entity_type !== "any" && attribute.entity_type !== type) attribute = undefined;

  // 5. Section (memory-policy.md §9.1): attribute, entity type, hint, Unsorted.
  const sectionId =
    attribute?.section_id ??
    (type === "person" ? SECTION.people : type === "project" ? SECTION.projects : undefined) ??
    hintSection ??
    SECTION.unsorted;

  return {
    entity: existing
      ? { id: existing.id, type: existing.type, isNew: false }
      : { name: input.entity.trim().slice(0, 80), type, isNew: true },
    attribute,
    sectionId,
    isPeopleSection: sectionId === SECTION.people,
    tasteClass: attribute ? attribute.taste_class === 1 : sectionId === SECTION.interests,
  };
}
