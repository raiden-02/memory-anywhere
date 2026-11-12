// Contract tests for the policy (memory-policy.md §5–§6): the texts in policy.md are the spec's,
// byte for byte; every channel fits its budget and carries the policy marker.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelBlocks, policyVersion } from "../scripts/policy-texts.ts";
import { BUDGETS, codePoints, SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX } from "../src/policy/budgets.ts";
import { POLICY_VERSION, SHORT_LIVED, TEXTS, type TextId } from "../src/policy/generated.ts";
import { lexicon } from "../src/policy/lexicon.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SPEC = readFileSync(join(ROOT, "docs/spec/memory-policy.md"), "utf8");
const POLICY = readFileSync(join(ROOT, "packages/server/policy/policy.md"), "utf8");
const IDS = Object.keys(TEXTS) as TextId[];

describe("policy texts", () => {
  it("policy.md holds exactly the spec's §6 blocks, byte for byte", () => {
    expect(Object.fromEntries(channelBlocks(POLICY))).toEqual(Object.fromEntries(channelBlocks(SPEC)));
    expect(policyVersion(POLICY)).toBe("P1");
    expect(POLICY_VERSION).toBe("P1");
  });

  it("has a budget for every channel and no budget without a channel", () => {
    expect(Object.keys(BUDGETS).sort()).toEqual([...IDS].sort());
  });

  it.each(IDS)("%s fits its budget and names the policy version", (id) => {
    const text = TEXTS[id];
    const b = BUDGETS[id];
    expect(codePoints(text)).toBeLessThanOrEqual(b.max);
    expect(text).toContain(`policy ${POLICY_VERSION}`);
    if (b.triggerWithin) expect(text.indexOf(". ")).toBeLessThan(b.triggerWithin);
    if (b.selfContainedWithin) expect(codePoints(text.split("\n\n")[0] ?? "")).toBeLessThanOrEqual(b.selfContainedWithin);
    if (b.maxLines) expect(text.split("\n").length).toBeLessThanOrEqual(b.maxLines);
  });

  it("keeps the skill's description and body within their own limits", () => {
    const [, frontMatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(TEXTS.skill) ?? [];
    const description = /^description: (.*)$/m.exec(frontMatter ?? "")?.[1] ?? "";
    expect(codePoints(description)).toBeGreaterThan(0);
    expect(codePoints(description)).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
    expect(codePoints(body ?? "")).toBeGreaterThan(0);
    expect(codePoints(body ?? "")).toBeLessThanOrEqual(SKILL_BODY_MAX);
  });

  it("asks for pronoun-free facts wherever a model is told how to write one (ADR-0103)", () => {
    for (const id of ["server-instructions", "desc-memory_save", "cursor-rule", "skill", "extractor-prompt"] as const) {
      expect(TEXTS[id]).toMatch(/without pronouns/);
    }
  });

  it("tool descriptions describe rather than command (ADR-0104)", () => {
    for (const id of ["desc-memory_save", "desc-memory_recall", "desc-memory_profile", "desc-memory_forget", "desc-memory_status"] as const) {
      expect(TEXTS[id]).not.toMatch(/^(Call|Save|Look up|Load|Forget|Report)\b/);
      expect(TEXTS[id]).not.toMatch(/\bMention it to the user\b|\bNever save\b|\bDo not save\b/);
    }
  });
});

describe("lexicon matching", () => {
  it("word mode needs boundaries; substring mode does not", () => {
    const words = lexicon(["this pr", "today"], "word");
    expect(words.firstMatch("fixing this pr now")).toBe("this pr");
    expect(words.matches("this project is big")).toBe(false);
    expect(words.matches("todays meeting")).toBe(false);
    expect(lexicon(["remember"], "substring").matches("i remembered it")).toBe(true);
  });

  it.each(SHORT_LIVED)("short-lived %j matches inside a sentence on word boundaries", (phrase) => {
    const lex = lexicon([phrase], "word");
    expect(lex.matches(`note: ${phrase}, then more`)).toBe(true);
    expect(lex.matches(`x${phrase.replace(/ /g, "")}x`)).toBe(false);
  });
});
