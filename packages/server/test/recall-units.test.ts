// Pure parts of the read path: time parsing (retrieval.md §2 step 2, §3), the query check and FTS
// query (step 1, 3), and escaping (§9).

import { describe, expect, it } from "vitest";
import { ftsQuery, specificEnough } from "../src/recall/recall.ts";
import { escapeText, memoryLine } from "../src/recall/render.ts";
import { localDate, overlaps, readTime, trueAt } from "../src/recall/time.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

describe("time", () => {
  it.each([
    ["what did I do last month", { from: "2026-10-01", to: "2026-11-01" }],
    ["projects in 2024", { from: "2024-01-01", to: "2025-01-01" }],
    ["jobs between 2020 and 2022", { from: "2020-01-01", to: "2023-01-01" }],
    ["trips in March 2025", { from: "2025-03-01", to: "2025-04-01" }],
    ["trips last year", { from: "2025-01-01", to: "2026-01-01" }],
    ["the meeting yesterday", { from: "2026-11-09", to: "2026-11-10" }],
  ])("%s → %o", (q, range) => {
    expect(readTime(q, NOW, "UTC").range).toEqual(range);
  });

  it("reads dates in the owner's time zone", () => {
    // 02:00 UTC on 10 Nov is still 9 Nov in Denver.
    expect(localDate(Date.parse("2026-11-10T02:00:00Z"), "America/Denver")).toBe("2026-11-09");
    expect(readTime("yesterday", Date.parse("2026-11-10T02:00:00Z"), "America/Denver").range).toEqual({ from: "2026-11-08", to: "2026-11-09" });
  });

  it("past markers bring history in; a query of only time words is time-only", () => {
    expect(readTime("where I used to live", NOW, "UTC").includePast).toBe(true);
    expect(readTime("where I live", NOW, "UTC").includePast).toBe(false);
    expect(readTime("last year", NOW, "UTC").timeOnly).toBe(true);
    expect(readTime("trips last year", NOW, "UTC").timeOnly).toBe(false);
    expect(readTime("favourite food", NOW, "UTC")).toEqual({ range: undefined, includePast: false, timeOnly: false });
  });

  it("overlaps half-open intervals of partial dates; an open start overlaps anything before the end", () => {
    const y2024 = { from: "2024-01-01", to: "2025-01-01" };
    expect(overlaps("2023-06", "2024-02", y2024)).toBe(true);
    expect(overlaps("2025", null, y2024)).toBe(false);
    expect(overlaps("2020", "2024-01-01", y2024)).toBe(false);
    expect(overlaps(null, "2024-03", y2024)).toBe(true);
    expect(overlaps(null, "2023", y2024)).toBe(false);
    expect(trueAt("2024-03", null, "2024-03-01")).toBe(true);
    expect(trueAt("2024-03", "2024-06", "2024-06-01")).toBe(false);
  });
});

describe("query check and FTS query", () => {
  it.each([["jazz", true], ["the", false], ["*", false], ["a b", false], ["cat", false], ["my cat food", true]])("%s → %s", (q, ok) => {
    expect(specificEnough(q)).toBe(ok);
  });

  it("quotes each token, drops stopwords, and does not strip a trailing s", () => {
    expect(ftsQuery('Where does the user keep "notes"?')).toBe('"user" OR "keep" OR "notes"');
  });
});

describe("rendering", () => {
  it("escapes markdown so stored text cannot open a heading, a link or a memory line", () => {
    expect(escapeText("# Title\n- [mem_X](http://x) `rm` | *b* !<i>")).toBe("\\# Title - \\[mem_X\\]\\(http://x) 'rm' \\| \\*b\\* \\!\\<i\\>");
  });

  it("renders one line with kind, section, dates, tier and client", () => {
    const line = memoryLine({
      id: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C", kind: "fact", entity: "self", section: "Profile", attribute: "city", content: "Lives in Denver, CO.",
      valid_from: "2025-06", valid_to: null, recorded_at: "2026-11-10T12:00:00.000Z", tier: "T0", status: "active", via: "Claude", expires_at: null,
    });
    expect(line).toBe("- [mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C] (fact · Profile · since 2025-06 · T0 (owner) · via Claude) Lives in Denver, CO.");
  });
});

describe("time names a period only when it is explicit (spec-issues #46)", () => {
  it("gives no range for a weekday or time of day alone", () => {
    expect(readTime("what time do I wake up on Saturday mornings", NOW, "UTC").range).toBeUndefined();
    expect(readTime("what did I cook on Wednesday", NOW, "UTC").range).toBeUndefined();
  });
});
