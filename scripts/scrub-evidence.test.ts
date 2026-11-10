import { describe, expect, it } from "vitest";
import { scrub } from "./scrub-evidence.ts";

const domain = "memory.owner-test.net";

describe("scrub", () => {
  it("replaces the owner domain case-insensitively, keeping subdomain labels", () => {
    const { text, counts } = scrub("curl https://Spike.MEMORY.owner-test.net/mcp and admin.memory.owner-test.net", { domain });
    expect(text).toBe("curl https://Spike.{host}/mcp and admin.{host}");
    expect(counts.domain).toBe(2);
  });

  it("replaces 12-digit account ids but not longer numbers", () => {
    const { text } = scrub("arn:aws:iam::123456789012:role/x ts=1731000000000", { domain });
    expect(text).toBe("arn:aws:iam::<aws-account-id>:role/x ts=1731000000000");
  });

  it("leaves decimal numbers alone, so JSON results stay valid", () => {
    const json = '{"ndcg":0.123456789012,"big":123456789012.5,"id":"123456789012"}';
    const { text, counts } = scrub(json, { domain });
    expect(text).toBe('{"ndcg":0.123456789012,"big":123456789012.5,"id":"<aws-account-id>"}');
    expect(counts.accountIds).toBe(1);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("still replaces an account id at the end of a sentence", () => {
    expect(scrub("signed in to account 123456789012.", { domain }).text).toBe("signed in to account <aws-account-id>.");
  });

  it("replaces real email addresses and keeps spec placeholders", () => {
    const { text } = scrub("to me+ma-deploy@gmail.com, cc you+ma-aws@example.com", { domain });
    expect(text).toBe("to <email>, cc you+ma-aws@example.com");
  });

  it("redacts bearer tokens, AWS key ids and credential JSON fields", () => {
    const input = `Authorization: Bearer abcDEF123456789xyz
{"AccessKeyId":"ASIAABCDEFGHIJKLMNOP","SecretAccessKey":"s3cr3t","client_secret":"zzz"}`;
    const { text, counts } = scrub(input, { domain });
    expect(text).toBe(`Authorization: Bearer <redacted-token>
{"AccessKeyId":"<aws-access-key-id>","SecretAccessKey":"<redacted>","client_secret":"<redacted>"}`);
    expect(counts.secrets).toBe(4);
  });

  it("refuses a value that is not a hostname", () => {
    expect(() => scrub("x", { domain: "" })).toThrow();
    expect(() => scrub("x", { domain: "abc" })).toThrow();
  });
});
