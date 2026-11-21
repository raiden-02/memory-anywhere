// `mema cost aws [--month YYYY-MM]` (deployment-aws.md §10): what the memory-anywhere AWS account
// was billed for one month, per service, read from Cost Explorer with the deploy sign-in (read-only
// `ce:GetCostAndUsage`). The account holds nothing else, so its bill is the
// system's cost.
//
//   sts get-caller-identity ─ the deploy permission set? ─► ce get-cost-and-usage (1 request, $0.01)
//                                                           grouped by service and usage type
//   ──► per service: billed $   per usage type: quantity and $   days measured / days in month
//   ──► aws sso logout
//
// A free trial or credit bills some usage at $0; the usage quantities are printed so the cost
// after it ends can be worked out from AWS's on-demand prices.

import { DeployError, must, type Runner } from "./process.ts";

export interface CostOptions {
	readonly profile: string;
	/** YYYY-MM; the current UTC month when absent. */
	readonly month?: string;
}

export interface CostDeps {
	readonly run: Runner;
	readonly now: () => number;
	readonly log: (line: string) => void;
}

export interface UsageLine {
	readonly service: string;
	readonly usageType: string;
	readonly quantity: number;
	readonly unit: string;
	readonly usd: number;
}

export interface MonthCost {
	readonly start: string;
	/** Exclusive, as Cost Explorer takes it. */
	readonly end: string;
	readonly daysMeasured: number;
	readonly daysInMonth: number;
	readonly lines: readonly UsageLine[];
}

const DAY_MS = 86_400_000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The month's start and Cost Explorer end date: the next month's first day, or tomorrow for the current month. */
export function monthPeriod(
	month: string | undefined,
	now: number,
): { start: string; end: string; daysMeasured: number; daysInMonth: number } {
	const m = MONTH.exec(month ?? ymd(now).slice(0, 7));
	if (!m) throw new DeployError(`--month must be YYYY-MM, such as 2026-11; got ${JSON.stringify(month)}`);
	const startMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
	const nextMs = Date.UTC(Number(m[1]), Number(m[2]), 1);
	if (startMs > now) throw new DeployError(`${m[0]} has not started yet`);
	const todayMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
	const endMs = Math.min(nextMs, todayMs + DAY_MS);
	return {
		start: ymd(startMs),
		end: ymd(endMs),
		daysMeasured: Math.round((endMs - startMs) / DAY_MS),
		daysInMonth: Math.round((nextMs - startMs) / DAY_MS),
	};
}

interface CeResponse {
	ResultsByTime: { Groups?: { Keys: [string, string]; Metrics: Record<string, { Amount: string; Unit: string }> }[] }[];
}

/** Cost Explorer's answer as one line per service and usage type, dearest first. */
export function usageLines(json: string): UsageLine[] {
	const r = JSON.parse(json) as CeResponse;
	const byKey = new Map<string, UsageLine>();
	for (const period of r.ResultsByTime) {
		for (const g of period.Groups ?? []) {
			const [service, usageType] = g.Keys;
			const key = `${service}\u0000${usageType}`;
			const prev = byKey.get(key);
			const usd = Number(g.Metrics["UnblendedCost"]?.Amount ?? 0);
			const quantity = Number(g.Metrics["UsageQuantity"]?.Amount ?? 0);
			byKey.set(key, {
				service,
				usageType,
				quantity: (prev?.quantity ?? 0) + quantity,
				unit: g.Metrics["UsageQuantity"]?.Unit ?? "",
				usd: (prev?.usd ?? 0) + usd,
			});
		}
	}
	return [...byKey.values()].sort(
		(a, b) => b.usd - a.usd || a.service.localeCompare(b.service) || a.usageType.localeCompare(b.usageType),
	);
}

/** The printed report: services with their total, then each usage type under its service. */
export function formatCost(c: MonthCost): string[] {
	const services = new Map<string, UsageLine[]>();
	for (const l of c.lines) services.set(l.service, [...(services.get(l.service) ?? []), l]);
	const total = c.lines.reduce((s, l) => s + l.usd, 0);
	const usd = (n: number) => `$${n.toFixed(2)}`;
	const out = [`AWS bill ${c.start} to ${c.end} (exclusive): ${c.daysMeasured} of ${c.daysInMonth} days`, ""];
	for (const [service, lines] of [...services].sort((a, b) => sum(b[1]) - sum(a[1]))) {
		out.push(`${usd(sum(lines)).padStart(9)}  ${service}`);
		for (const l of lines)
			out.push(`${usd(l.usd).padStart(9)}    ${l.usageType}: ${trim(l.quantity)} ${l.unit}`.trimEnd());
	}
	out.push("", `${usd(total).padStart(9)}  total billed`);
	if (c.daysMeasured < c.daysInMonth && c.daysMeasured > 0) {
		out.push(`${usd((total / c.daysMeasured) * c.daysInMonth).padStart(9)}  the days so far scaled to the whole month`);
	}
	return out;
}

const sum = (lines: readonly UsageLine[]): number => lines.reduce((s, l) => s + l.usd, 0);
const trim = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/u, ""));

export async function costAws(opts: CostOptions, deps: CostDeps): Promise<MonthCost> {
	const period = monthPeriod(opts.month, deps.now());
	// Cost Explorer answers only in us-east-1, whatever the stack's region.
	const base = ["--profile", opts.profile, "--region", "us-east-1", "--output", "json"];
	let signedIn = false;
	try {
		const who = JSON.parse(
			await must(
				deps.run,
				"checking the SSO sign-in (run: aws sso login --sso-session ma-deploy --use-device-code)",
				"aws",
				["sts", "get-caller-identity", ...base],
			),
		) as { Arn: string };
		signedIn = true;
		if (!/:assumed-role\/AWSReservedSSO_memory-anywhere-deploy_[0-9a-f]+\//u.test(who.Arn)) {
			throw new DeployError(`profile ${opts.profile} is not signed in with the memory-anywhere-deploy permission set`);
		}
		const json = await must(
			deps.run,
			"reading Cost Explorer (the deploy permission set needs ce:GetCostAndUsage: re-run bootstrap-identity.sh once)",
			"aws",
			[
				"ce",
				"get-cost-and-usage",
				"--time-period",
				`Start=${period.start},End=${period.end}`,
				"--granularity",
				"MONTHLY",
				"--metrics",
				"UnblendedCost",
				"UsageQuantity",
				"--group-by",
				"Type=DIMENSION,Key=SERVICE",
				"Type=DIMENSION,Key=USAGE_TYPE",
				...base,
			],
		);
		const cost: MonthCost = { ...period, lines: usageLines(json) };
		for (const line of formatCost(cost)) deps.log(line);
		deps.log("(Cost Explorer charges $0.01 for this request.)");
		return cost;
	} finally {
		if (signedIn) {
			const r = await deps.run("aws", ["sso", "logout", "--profile", opts.profile]);
			deps.log(r.code === 0 ? "Signed out of the deploy SSO session." : `Warning: aws sso logout failed: ${r.stderr}`);
		}
	}
}
