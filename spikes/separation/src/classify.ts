// How one AWS CLI call ended, and whether that is what Q25 (m0-spike.md) expects.

export type Outcome = "allowed" | "denied" | "missing" | "error";

/** What a check must observe to pass. `deniedOrMissing` is for resources the
 * spike stack has not created yet: "missing" then counts as pending, not pass.
 * `deniedOrMissingUntilM2` is for prod resources, which exist only from M2:
 * "missing" is then deferred, and M2 re-runs the check against the prod stack. */
export type Expectation = "allowed" | "denied" | "deniedOrMissing" | "deniedOrMissingUntilM2";

export type Verdict = "pass" | "fail" | "pending" | "deferred";

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
  if (expect === "deniedOrMissingUntilM2" && outcome === "missing") return "deferred";
  return "fail";
}
