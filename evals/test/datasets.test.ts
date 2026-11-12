// The eval datasets' mechanical labelling: suite W's fact parse and suite P's generators.

import { describe, expect, it } from "vitest";
import { hasSecret } from "@memory-anywhere/contracts/redact";
import { buildProposals } from "../datasets/p/build.ts";
import { parseFact } from "../datasets/w/build.ts";

describe("suite W fact parse", () => {
  it("splits subject, lowercase relation and object, and refuses other shapes", () => {
    expect(parseFact("Thomas Kyd was born in the city of London.")).toEqual({ subject: "Thomas Kyd", relation: "was born in the city of", object: "London" });
    expect(parseFact("Agnieszka Holland is a citizen of United States of America.")).toEqual({ subject: "Agnieszka Holland", relation: "is a citizen of", object: "United States of America" });
    expect(parseFact("The director of Marvel Television is Jeph Loeb.")).toBeUndefined();
    expect(parseFact("Dikembe Mutombo plays the position of center.")).toBeUndefined();
    expect(parseFact("Santa Maria sopra Minerva is affiliated with the religion of Catholic Church.")).toBeUndefined();
  });
});

describe("suite P generators", () => {
  it("makes at least 100 secret and 100 sensitive proposals, and every secret really is one", () => {
    const p = buildProposals();
    const secrets = p.filter((x) => x.family.startsWith("secret"));
    expect(secrets.length).toBeGreaterThanOrEqual(100);
    expect(p.filter((x) => x.family.startsWith("sensitive")).length).toBeGreaterThanOrEqual(100);
    for (const s of secrets) expect(hasSecret(`${s.save.content} ${s.save.user_words ?? ""}`), s.id).toBe(true);
    for (const fam of ["instruction", "short-lived", "taste", "slot", "explicit", "model-inferred", "event"]) expect(p.filter((x) => x.family === fam).length).toBeGreaterThanOrEqual(50);
  });

  it("is the same set on every run", () => {
    expect(JSON.stringify(buildProposals())).toBe(JSON.stringify(buildProposals()));
  });
});
