// Static checks on the bootstrap IAM documents. These files are applied once by
// the owner in CloudShell and are hard to change afterwards, so the properties
// the design relies on (deployment-aws.md §3.3–§3.4) are pinned here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Statement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
interface PolicyDoc {
  Version: string;
  Statement: Statement[];
}

const IAM_DIR = path.join(import.meta.dirname, "..", "iam");
const raw = (name: string): string => readFileSync(path.join(IAM_DIR, name), "utf8");
const doc = (name: string): PolicyDoc => JSON.parse(raw(name)) as PolicyDoc;
const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const actions = (d: PolicyDoc, effect: "Allow" | "Deny"): string[] =>
  d.Statement.filter((s) => s.Effect === effect).flatMap((s) => list(s.Action));

// IAM quotas: customer managed policy 6,144 characters excluding whitespace;
// Identity Center permission-set inline policy 32,768 characters.
// cfn-exec is split in two only because of that quota (spec-issues.md #5); the
// CDK execution role gets both.
const MANAGED = ["cfn-exec.json", "cfn-exec-services.json", "boundary.json"];
const PERMISSION_SETS = ["deploy-permission-set.json", "operator-permission-set.json"];

describe("IAM documents", () => {
  for (const name of [...MANAGED, ...PERMISSION_SETS]) {
    it(`${name} is a valid policy with unique Sids and only known placeholders`, () => {
      const d = doc(name);
      expect(d.Version).toBe("2012-10-17");
      const sids = d.Statement.map((s) => s.Sid);
      expect(new Set(sids).size).toBe(sids.length);
      const placeholders = new Set(raw(name).match(/\$\{[^}]+\}/g) ?? []);
      const allowed = PERMISSION_SETS.includes(name)
        ? ["${ACCOUNT_ID}", "${aws:userid}"]
        : ["${ACCOUNT_ID}", "${REGION}"];
      for (const p of placeholders) expect(allowed).toContain(p);
      expect(raw(name)).not.toMatch(/\b\d{12}\b/); // no real account ids
    });
  }

  for (const name of MANAGED) {
    it(`${name} fits the managed-policy size quota`, () => {
      expect(raw(name).replace(/\s/g, "").length).toBeLessThanOrEqual(6144);
    });
  }

  for (const name of PERMISSION_SETS) {
    it(`${name} fits the permission-set inline policy quota`, () => {
      expect(raw(name).length).toBeLessThanOrEqual(32768);
    });
  }
});

describe("cfn-exec (§3.3)", () => {
  const d = doc("cfn-exec.json");

  it("creates roles only with the memory-anywhere boundary attached", () => {
    const s = d.Statement.find((x) => list(x.Action).includes("iam:CreateRole"));
    expect(s?.Condition?.["StringEquals"]?.["iam:PermissionsBoundary"]).toBe(
      "arn:aws:iam::${ACCOUNT_ID}:policy/memory-anywhere-boundary",
    );
    expect(list(s?.Resource)).toEqual(["arn:aws:iam::${ACCOUNT_ID}:role/memory-anywhere-*"]);
  });

  it("passes roles only to EC2 and DLM", () => {
    const s = d.Statement.find((x) => list(x.Action).includes("iam:PassRole"));
    expect(s?.Condition?.["StringEquals"]?.["iam:PassedToService"]).toEqual(["ec2.amazonaws.com", "dlm.amazonaws.com"]);
  });

  it("never allows Lambda, IAM users, access keys or editing managed policies", () => {
    const allowed = actions(d, "Allow");
    for (const a of allowed) expect(a).not.toMatch(/^(lambda|organizations|sso|identitystore):/);
    for (const forbidden of ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreatePolicy", "iam:CreatePolicyVersion"]) {
      expect(allowed).not.toContain(forbidden);
      expect(actions(d, "Deny")).toContain(forbidden);
    }
  });

  it("schedules key deletion only for tagged non-prod keys (owner decision, spec-issues #2)", () => {
    const s = d.Statement.find((x) => list(x.Action).includes("kms:ScheduleKeyDeletion"));
    expect(s?.Effect).toBe("Allow");
    expect(s?.Condition?.["StringNotEquals"]?.["aws:ResourceTag/memory-anywhere:stage"]).toBe("prod");
    expect(s?.Condition?.["Null"]?.["aws:ResourceTag/memory-anywhere:stage"]).toBe("false");
  });
});

describe("deploy permission set (§3.4)", () => {
  const d = doc("deploy-permission-set.json");
  const denied = actions(d, "Deny");

  it("denies every operator capability explicitly", () => {
    for (const a of [
      "ssm:StartSession", "ssm:SendCommand", "ssm:GetParameter*", "s3:GetObject*", "s3:Delete*",
      "kms:Decrypt", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy",
      "iam:*", "sso:*", "identitystore:*", "organizations:*", "cloudshell:*",
    ]) {
      expect(denied).toContain(a);
    }
  });

  it("can delete objects only in spike and eval buckets", () => {
    const s = d.Statement.find((x) => x.Sid === "EmptyNonProdBucketsOnDestroy");
    for (const r of list(s?.Resource)) expect(r).toMatch(/-(spike|eval-\*)(\/\*)?$/);
  });

  it("has no permissions boundary reference (R5-B1)", () => {
    expect(raw("deploy-permission-set.json")).not.toContain("memory-anywhere-boundary");
  });
});

describe("operator permission set (§3.4)", () => {
  const d = doc("operator-permission-set.json");

  it("cannot schedule key deletion, touch IAM or write CloudFormation", () => {
    const denied = actions(d, "Deny");
    expect(denied).toEqual(expect.arrayContaining(["kms:ScheduleKeyDeletion", "iam:*"]));
    const cfn = d.Statement.find((x) => x.Sid === "DenyCloudFormationWrites");
    expect(cfn?.Effect).toBe("Deny");
    expect(list(cfn?.NotAction).every((a) => /^cloudformation:(Describe|Get|List|Detect|Validate|Estimate)\*$/.test(a))).toBe(true);
  });

  it("may delete backup versions only outside prod", () => {
    const s = d.Statement.find((x) => x.Sid === "DeleteNonProdBackups");
    for (const r of list(s?.Resource)) expect(r).toMatch(/-(spike|eval-\*)(\/\*)?$/);
    const deny = d.Statement.find((x) => x.Sid === "DenyProdBackupVersionAndBucketDeletion");
    expect(list(deny?.Action)).toEqual(["s3:DeleteObjectVersion", "s3:DeleteBucket"]);
  });

  it("runs commands only on instances carrying the stage tag", () => {
    const s = d.Statement.find((x) => x.Sid === "SessionsAndRunCommandOnStageInstances");
    expect(s?.Condition?.["Null"]?.["ssm:resourceTag/memory-anywhere:stage"]).toBe("false");
  });
});
