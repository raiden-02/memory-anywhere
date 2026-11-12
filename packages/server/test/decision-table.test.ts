// write-path.md §14: one table-driven test per decision row (D1–D19 with D10a and D13b), each with
// a case where the row decides and a case where its condition is just missed.

import { describe, expect, it } from "vitest";
import { decide, type DecideInput } from "../src/write/decide.ts";
import type { AttributeRow, Resolution, Screens } from "../src/write/types.ts";

const SELF: Resolution = { entity: { id: "ent_self", type: "self", isNew: false }, attribute: undefined, sectionId: "sec_unsorted", isPeopleSection: false, tasteClass: false };
const CITY: AttributeRow = { id: "att_city", name: "city", entity_type: "self", cardinality: "one", section_id: "sec_profile", taste_class: 0, profile_key: 1, restricted: 0 };
const LIKES: AttributeRow = { ...CITY, id: "att_likes", name: "likes", cardinality: "many", section_id: "sec_interests", taste_class: 1, profile_key: 0 };
const NO_SCREENS = { secretHit: false, instructionHit: false, sensitiveCategory: undefined, shortLivedHit: false, suppressionHit: false };
const STATED = { content: "Prefers short answers", qualifyingUserWords: true, rememberIntent: false };
const UNSTATED = { content: "Prefers short answers", qualifyingUserWords: false, rememberIntent: false };

const base: DecideInput = {
  tier: 2, channel: "mcp", kind: "fact", explicitRequest: false, supersedes: undefined, verified: UNSTATED, screens: NO_SCREENS,
  resolution: SELF, duplicateOf: undefined, floored: false, canElicit: false, elicitationAnswer: undefined,
};
const at = (o: Omit<Partial<DecideInput>, "screens"> & { screens?: Partial<Screens> }): DecideInput => ({
  ...base, ...o, screens: { ...NO_SCREENS, ...(o.screens ?? {}) },
});
const sensitive = { sensitiveCategory: "health" as const };

type Case = readonly [row: string, passes: DecideInput, misses: DecideInput];

const CASES: readonly Case[] = [
  ["D1", at({ screens: { secretHit: true } }), at({})],
  ["D2", at({ screens: { instructionHit: true } }), at({ tier: 0, screens: { instructionHit: true } })],
  ["D3", at({ screens: sensitive, resolution: { ...SELF, entity: { id: "ent_x", type: "person", isNew: false } } }), at({ screens: sensitive })],
  ["D4", at({ tier: 0, screens: sensitive }), at({ screens: sensitive })],
  ["D5", at({ screens: sensitive, explicitRequest: true }), at({ screens: sensitive })],
  ["D6", at({ screens: sensitive }), at({ screens: sensitive, verified: { ...UNSTATED, rememberIntent: true } })],
  ["D7", at({ screens: { suppressionHit: true }, canElicit: true }), at({ screens: { suppressionHit: true }, channel: "spool_save", canElicit: true })],
  ["D8", at({ screens: { suppressionHit: true } }), at({ tier: 0, screens: { suppressionHit: true } })],
  ["D9", at({ screens: { shortLivedHit: true } }), at({ screens: { shortLivedHit: true }, kind: "event" })],
  ["D10", at({ duplicateOf: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" }), at({})],
  ["D10a", at({ tier: 0 }), at({ tier: 1 })],
  ["D11", at({ floored: true }), at({ floored: true, tier: 1 })],
  ["D12", at({ supersedes: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" }), at({})],
  ["D13", at({ kind: "event", verified: STATED }), at({ kind: "event" })],
  ["D13b", at({ kind: "event" }), at({ kind: "fact" })],
  ["D14", at({ explicitRequest: true, verified: { ...STATED, rememberIntent: true } }), at({ explicitRequest: true, verified: STATED })],
  ["D15", at({ kind: "preference", verified: STATED }), at({ kind: "preference" })],
  ["D16", at({ resolution: { ...SELF, attribute: CITY }, verified: STATED }), at({ resolution: { ...SELF, attribute: CITY } })],
  ["D17", at({ resolution: { ...SELF, attribute: LIKES, tasteClass: true } }), at({ resolution: { ...SELF, attribute: CITY } })],
  ["D18", at({ verified: STATED }), at({})],
  ["D19", at({}), at({ verified: STATED })],
];

describe("decision table", () => {
  it("has a case pair for every row", () => {
    expect(CASES.map((c) => c[0])).toEqual([
      "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D10a", "D11", "D12", "D13", "D13b", "D14", "D15", "D16", "D17", "D18", "D19",
    ]);
  });

  it.each(CASES)("%s decides when its condition holds, and not when it is just missed", (row, passes, misses) => {
    expect(decide(passes).row).toBe(row);
    expect(decide(misses).row).not.toBe(row);
  });
});

describe("row outcomes", () => {
  it("D1 rejects a secret even from the owner", () => {
    expect(decide(at({ tier: 0, screens: { secretHit: true } }))).toMatchObject({ kind: "reject", reason: "secret" });
  });

  it("D5 holds an unverifiable sensitive request for the owner, and elicits when the client can", () => {
    expect(decide(at({ screens: sensitive, explicitRequest: true }))).toMatchObject({ kind: "review", reason: "sensitive_needs_owner", reviewKind: "sensitive" });
    expect(decide(at({ screens: sensitive, explicitRequest: true, canElicit: true }))).toMatchObject({ kind: "elicit" });
    expect(decide(at({ screens: sensitive, explicitRequest: true, canElicit: true, elicitationAnswer: true }))).toMatchObject({ kind: "active", tier: 1, reason: "sensitive_confirmed" });
    expect(decide(at({ screens: sensitive, explicitRequest: true, canElicit: true, elicitationAnswer: false }))).toMatchObject({ kind: "reject", reason: "user_declined" });
  });

  it("D7 Yes continues at T1 past the suppression", () => {
    expect(decide(at({ screens: { suppressionHit: true }, canElicit: true, elicitationAnswer: true, verified: STATED }))).toMatchObject({ row: "D18", tier: 1 });
  });

  it("D15 without elicitation stores the preference at T2 and asks the owner to confirm it", () => {
    expect(decide(at({ kind: "preference", verified: STATED }))).toMatchObject({ kind: "active", tier: 2, preferenceConfirm: true, reason: "stated_preference" });
  });

  it("at T0 short-lived wording does not reject: the owner's word is final", () => {
    expect(decide(at({ tier: 0, screens: { shortLivedHit: true } })).row).toBe("D10a");
  });

  it("the elicitation question quotes at most 200 characters of the content", () => {
    const long = "x".repeat(500);
    const d = decide(at({ kind: "preference", verified: { ...STATED, content: long }, canElicit: true }));
    expect(d.kind).toBe("elicit");
    if (d.kind === "elicit") expect(d.question).toContain(`“${"x".repeat(200)}”`);
  });
});
