import { describe, expect, it } from "vitest";
import { findSecrets, hasSecret, ibanValid, luhnValid, redact, shannonEntropy } from "../src/redact.ts";

// One positive and one negative example per family (memory-policy.md §3.7). Positives are
// synthetic, and token-shaped ones are assembled at run time with `t()` so that the source never
// holds a literal token (secret scanners on pushes would otherwise flag the test file).
const t = (...parts: string[]) => parts.join("");
const FAMILIES: readonly (readonly [type: string, secret: string, nearMiss: string])[] = [
  ["aws_access_key", `key ${t("AKIA", "IOSFODNN7EXAMPLE")} here`, "key AKIAIOSFODNN7 here"],
  ["aws_secret", "aws secret wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYaa", "plain wJalrXUtnFEMIK7MDENG text without the provider"],
  ["github_token", `token ${t("ghp", "_0123456789abcdefghijABCDEFGHIJ012345")}`, "the gh_cli tool is installed"],
  ["github_token", `pat ${t("github", "_pat_", "A1b2".repeat(21))}`, "github_pat_short"],
  ["slack_token", `slack ${t("xox", "b-1234567890-abcdefghij")}`, "xoxo hugs and kisses"],
  ["anthropic_key", `use ${t("sk-", "ant-api03-abcdefghijklmnopqrstuv")}`, "the sk-ant prefix alone"],
  ["openai_key", `OPENAI ${t("sk-", "proj_abcdefghijklmnopqrstu")}`, "sk-short"],
  ["google_api_key", t("AI", "zaSyA1234567890abcdefghijklmnopqrstuv"), "AIza is a prefix"],
  ["stripe_key", t("sk_", "live_", "abcdefghijklmnopqrstuvwx"), "sk_live_short"],
  ["private_key", t("-----BEGIN RSA ", "PRIVATE KEY-----"), "-----BEGIN CERTIFICATE-----"],
  ["jwt", t("eyJhbGciOiJIUzI1.", "eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"), "eyJ alone is not a token"],
  ["payment_card", "card 4111 1111 1111 1111 exp", "order 4111 1111 1111 1112 shipped"],
  ["iban", "GB82WEST12345698765432", "GB82WEST12345698765431"],
  ["us_ssn", "ssn 123-45-6789", "phone 123-456-7890"],
  ["aadhaar", "aadhaar 1234 5678 9012", "year 2024 and 5678"],
  ["passport", "Passport No: K1234567", "passport office hours"],
  ["password", "my password is hunter2!", "I forgot which password manager to use"],
  ["high_entropy", "token a8F3kQ9zL2mX7pR4tY6wB1nV5", "a perfectly ordinary sentence without any long token"],
];

describe("secret families", () => {
  it.each(FAMILIES)("%s: detects the secret and ignores the near miss", (type, secret, nearMiss) => {
    expect(findSecrets(secret).map((m) => m.type)).toContain(type);
    expect(findSecrets(nearMiss).map((m) => m.type)).not.toContain(type);
  });
});

describe("redact", () => {
  it("replaces each secret with its label and keeps the rest", () => {
    const r = redact(`deploy with ${t("ghp", "_0123456789abcdefghijABCDEFGHIJ012345")} then call 123-45-6789`);
    expect(r.text).toBe("deploy with [REDACTED:github_token] then call [REDACTED:us_ssn]");
    expect(r.types).toEqual(["github_token", "us_ssn"]);
  });

  it("leaves clean text untouched", () => {
    expect(redact("I prefer short answers")).toEqual({ text: "I prefer short answers", types: [] });
    expect(hasSecret("I prefer short answers")).toBe(false);
  });

  it("prefers the specific Anthropic label over the generic sk- rule", () => {
    const key = t("sk-", "ant-api03-abcdefghijklmnopqrstuv");
    expect(findSecrets(key)).toEqual([{ type: "anthropic_key", start: 0, end: key.length }]);
  });

  it("never returns overlapping matches", () => {
    const m = findSecrets(`x ${t("eyJhbGciOiJIUzI1.", "eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4")} y`);
    expect(m).toHaveLength(1);
  });
});

describe("checksums and entropy", () => {
  it("Luhn", () => {
    expect(luhnValid("4111-1111-1111-1111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  it("IBAN mod-97", () => {
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
  });
  it("Shannon entropy", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});
