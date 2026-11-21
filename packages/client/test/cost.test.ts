// mema cost aws (deployment-aws.md §10): the month's period, Cost Explorer's answer per service and
// usage type, the sign-in check and the sign-out.

import { describe, expect, it } from "vitest";
import { costAws, formatCost, monthPeriod, usageLines } from "../src/deploy/cost.ts";
import type { RunResult } from "../src/deploy/process.ts";

const DEPLOY_ARN =
	"arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_memory-anywhere-deploy_0123456789abcdef/ma-deploy";
const NOV_17 = Date.parse("2026-11-17T15:00:00Z");

const group = (service: string, usageType: string, usd: string, quantity: string, unit: string) => ({
	Keys: [service, usageType],
	Metrics: { UnblendedCost: { Amount: usd, Unit: "USD" }, UsageQuantity: { Amount: quantity, Unit: unit } },
});
const ANSWER = JSON.stringify({
	ResultsByTime: [
		{
			Groups: [
				group("Amazon Simple Storage Service", "Requests-Tier1", "0.0105", "2100", "Requests"),
				group("Amazon Elastic Compute Cloud - Compute", "BoxUsage:t4g.small", "0", "408", "Hrs"),
				group("EC2 - Other", "EBS:VolumeUsage.gp3", "0.9067", "11.33", "GB-Mo"),
				group("Amazon Simple Storage Service", "TimedStorage-ByteHrs", "0.0021", "0.09", "GB-Mo"),
			],
		},
	],
});

describe("mema cost aws", () => {
	it("measures a past month whole, and the current month to tomorrow", () => {
		expect(monthPeriod("2026-10", NOV_17)).toEqual({
			start: "2026-10-01",
			end: "2026-11-01",
			daysMeasured: 31,
			daysInMonth: 31,
		});
		expect(monthPeriod(undefined, NOV_17)).toEqual({
			start: "2026-11-01",
			end: "2026-11-18",
			daysMeasured: 17,
			daysInMonth: 30,
		});
		expect(() => monthPeriod("2026-13", NOV_17)).toThrow(/--month must be YYYY-MM/);
		expect(() => monthPeriod("2026-12", NOV_17)).toThrow(/has not started yet/);
	});

	it("lists services dearest first with each usage type's quantity, and scales a partial month", () => {
		const lines = usageLines(ANSWER);
		expect(lines.map((l) => l.usageType)).toEqual([
			"EBS:VolumeUsage.gp3",
			"Requests-Tier1",
			"TimedStorage-ByteHrs",
			"BoxUsage:t4g.small",
		]);
		const text = formatCost({ ...monthPeriod(undefined, NOV_17), lines }).join("\n");
		expect(text).toContain("    $0.91  EC2 - Other");
		expect(text).toContain("    $0.00    BoxUsage:t4g.small: 408 Hrs");
		expect(text).toContain("    $0.92  total billed");
		expect(text).toContain("    $1.62  the days so far scaled to the whole month");
	});

	it("refuses another sign-in, asks Cost Explorer once in us-east-1, and always signs out", async () => {
		const calls: string[][] = [];
		const run =
			(arn: string) =>
			async (command: string, args: string[]): Promise<RunResult> => {
				calls.push([command, ...args]);
				if (args[0] === "sts") return { code: 0, stdout: JSON.stringify({ Arn: arn }), stderr: "" };
				if (args[0] === "ce") return { code: 0, stdout: ANSWER, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
		const log: string[] = [];
		await costAws(
			{ profile: "memory-anywhere-deploy" },
			{ run: run(DEPLOY_ARN), now: () => NOV_17, log: (l) => log.push(l) },
		);
		const ce = calls.find((c) => c[1] === "ce");
		expect(ce).toEqual(expect.arrayContaining(["get-cost-and-usage", "Start=2026-11-01,End=2026-11-18", "us-east-1"]));
		expect(calls.filter((c) => c[1] === "ce")).toHaveLength(1);
		expect(calls.at(-1)).toEqual(["aws", "sso", "logout", "--profile", "memory-anywhere-deploy"]);

		calls.length = 0;
		const operator =
			"arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_memory-anywhere-operator_0123456789abcdef/ma-operator";
		await expect(
			costAws({ profile: "p" }, { run: run(operator), now: () => NOV_17, log: () => undefined }),
		).rejects.toThrow(/not signed in with the memory-anywhere-deploy/);
		expect(calls.map((c) => c[1])).toEqual(["sts", "sso"]);
	});
});
