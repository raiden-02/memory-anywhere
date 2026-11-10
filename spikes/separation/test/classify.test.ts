import { describe, expect, it } from "vitest";
import { classify, judge } from "../src/classify.ts";

describe("classify", () => {
  it("treats exit 0 as allowed", () => {
    expect(classify(0, "")).toBe("allowed");
  });

  it.each([
    "An error occurred (AccessDeniedException) when calling the GetParameter operation: User: arn:aws:sts::x is not authorized to perform: ssm:GetParameter with an explicit deny",
    "An error occurred (AccessDenied) when calling the AssumeRole operation",
    "fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden",
    "An error occurred (UnauthorizedOperation) when calling the DescribeX operation",
  ])("recognises a denial: %s", (stderr) => {
    expect(classify(254, stderr)).toBe("denied");
  });

  it("prefers denied over missing when both appear", () => {
    expect(classify(254, "(404) ... AccessDenied")).toBe("denied");
  });

  it.each([
    "An error occurred (ParameterNotFound) when calling the GetParameter operation",
    "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found",
    "An error occurred (NoSuchBucket) when calling the GetObject operation",
  ])("recognises a missing resource: %s", (stderr) => {
    expect(classify(254, stderr)).toBe("missing");
  });

  it("reports anything else as an error", () => {
    expect(classify(255, "Could not connect to the endpoint URL")).toBe("error");
  });
});

describe("judge", () => {
  it("passes an expected denial and fails an unexpected success", () => {
    expect(judge("denied", "denied")).toBe("pass");
    expect(judge("denied", "allowed")).toBe("fail");
    expect(judge("denied", "missing")).toBe("fail");
  });

  it("keeps a missing resource pending instead of passing it", () => {
    expect(judge("deniedOrMissing", "missing")).toBe("pending");
    expect(judge("deniedOrMissing", "denied")).toBe("pass");
    expect(judge("deniedOrMissing", "allowed")).toBe("fail");
  });

  it("defers a prod resource that does not exist yet, but still fails if it is readable", () => {
    expect(judge("deniedOrMissingUntilM2", "missing")).toBe("deferred");
    expect(judge("deniedOrMissingUntilM2", "denied")).toBe("pass");
    expect(judge("deniedOrMissingUntilM2", "allowed")).toBe("fail");
  });

  it("requires success when success is expected", () => {
    expect(judge("allowed", "allowed")).toBe("pass");
    expect(judge("allowed", "denied")).toBe("fail");
  });
});
