import { describe, expect, it } from "vitest";
import { contentNormHash, contentWords, norm, normEntity } from "../src/normalize.ts";

describe("norm", () => {
  it.each([
    ["  Prefers   short\tanswers. ", "prefers short answers"],
    ["User likes tea!", "likes tea"],
    ["I live in Lisbon?!", "live in lisbon"],
    ["likes tea .", "likes tea"],
    ["ﬁve ＡＢＣ", "five abc"], // NFKC folds the ligature and full-width letters
    ["Iceland is cold", "iceland is cold"], // only a leading "i " word is stripped
  ])("%j → %j", (input, expected) => expect(norm(input)).toBe(expected));
});

describe("contentNormHash", () => {
  it("equals for texts that normalize the same, and is lowercase hex SHA-256", () => {
    expect(contentNormHash("Likes tea.")).toBe(contentNormHash("  likes TEA"));
    expect(contentNormHash("likes tea")).toMatch(/^[0-9a-f]{64}$/);
    expect(contentNormHash("likes tea")).not.toBe(contentNormHash("likes coffee"));
  });
});

describe("contentWords", () => {
  it("drops stopwords and a trailing s from words longer than 3 characters", () => {
    expect(contentWords("I really like the movies and cats")).toEqual(["really", "like", "movie", "cat"]);
    expect(contentWords("is was gas")).toEqual(["gas"]); // "gas" has 3 characters, so it keeps its s
  });
});

describe("normEntity", () => {
  it("folds hyphens, underscores and dots", () => {
    expect(normEntity("Memory-Anywhere")).toBe("memory anywhere");
    expect(normEntity("memory_anywhere")).toBe("memory anywhere");
    expect(normEntity("memory.anywhere")).toBe("memory anywhere");
    expect(normEntity("memory -- anywhere")).toBe("memory anywhere");
  });
});
