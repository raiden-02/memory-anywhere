// How one AWS CLI call ended, and whether that is what Q25 (m0-spike.md) expects.

export type Outcome = "allowed" | "denied" | "missing" | "error";

/** What a check must observe to pass. `deniedOrMissing` is for resources the
 * spike stack has not created yet: "missing" then counts as pending, not pass. */
export type Expectation = "allowed" | "denied" | "deniedOrMissing";

export type Verdict = "pass" | "fail" | "pending";

const DENIED = [
  /AccessDenied/i,
  /UnauthorizedOperation/,
  /is not authorized to perform/i,
  /explicit deny/i,
  /\bForbidden\b/,
  /\(403\)/,
];

const MISSING = [/ParameterNotFound/, /NoSuchBucket/, /NoSuchKey/, /\(404\)/, /InvalidInstanceId/, /TargetNotConnected/];

export function classify(exitCode: number, stderr: string): Outcome {
  if (exitCode === 0) return "allowed";
  if (DENIED.some((re) => re.test(stderr))) return "denied";
  if (MISSING.some((re) => re.test(stderr))) return "missing";
  return "error";
}

export function judge(expect: Expectation, outcome: Outcome): Verdict {
  if (expect === "allowed") return outcome === "allowed" ? "pass" : "fail";
  if (outcome === "denied") return "pass";
  if (expect === "deniedOrMissing" && outcome === "missing") return "pending";
  return "fail";
}
