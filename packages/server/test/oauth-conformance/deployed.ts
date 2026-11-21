// A deployed stage as a conformance target: an eval stack running the release. The same tests that
// run against the local issuer run here over the network:
//
//   MA_CONFORMANCE_ORIGIN=https://eval.{host}  MA_CONFORMANCE_STAGE=eval-<id>
//   MA_CONFORMANCE_OWNER=<file outside the repo>  pnpm vitest run conformance.test.ts
//
// The eval owner is two soft passkeys. The first run enrols them with the stage's setup token,
// read from SSM with the deploy profile, and saves them to MA_CONFORMANCE_OWNER,
// so later runs and other suites sign in as the same owner. Eval data is synthetic.
//
// The stage keeps its production rate limits: a 429 is waited out (Retry-After) and retried.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { SoftAuthenticator } from "./authenticator.ts";
import { Browser, ownerSetup, type Target } from "./issuer.ts";

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DeployedTarget extends Target {
	/** The owner's admin session: setup on the first run, passkey sign-in after that. */
	owner(): Promise<Browser>;
}

export interface DeployedEnv {
	origin: string;
	stage: string;
	ownerFile: string;
	profile: string;
	region: string;
}

/** The deployed target named by the environment, or undefined when MA_CONFORMANCE_ORIGIN is unset. */
export function deployedEnv(env: NodeJS.ProcessEnv = process.env): DeployedEnv | undefined {
	const origin = env["MA_CONFORMANCE_ORIGIN"]?.replace(/\/$/u, "");
	if (!origin) return undefined;
	return {
		origin,
		stage: env["MA_CONFORMANCE_STAGE"] ?? "",
		ownerFile: env["MA_CONFORMANCE_OWNER"] ?? "",
		profile: env["MA_AWS_PROFILE"] ?? "memory-anywhere-deploy",
		region: env["MA_AWS_REGION"] ?? "us-east-1",
	};
}

/** fetch, waiting out each 429 for its Retry-After, as a well-behaved client does. */
export function retryRateLimited(base: typeof fetch): typeof fetch {
	return async (input, init) => {
		for (let attempt = 0; ; attempt++) {
			const res = await base(input, init);
			if (res.status !== 429 || attempt === 30) return res;
			const wait = Number(res.headers.get("retry-after") ?? "5");
			await res.arrayBuffer();
			await sleep((Number.isFinite(wait) ? wait : 5) * 1000 + 250);
		}
	};
}

export function connectDeployed(e: DeployedEnv): DeployedTarget {
	// These suites pair and revoke apps and enrol an owner: eval stages only, never prod.
	if (!/^eval-[a-z0-9]{1,12}$/u.test(e.stage))
		throw new Error(`the stage must be an eval stage (eval-<id>), not ${JSON.stringify(e.stage)}`);
	if (!e.ownerFile)
		throw new Error(
			"name a file outside the repository for the eval owner's passkeys (MA_CONFORMANCE_OWNER or --owner)",
		);
	const host = new URL(e.origin).hostname;
	const adminOrigin = `https://admin.${host}`;
	const saved = existsSync(e.ownerFile)
		? (JSON.parse(readFileSync(e.ownerFile, "utf8")) as { origin: string; keys: [string, string] })
		: undefined;
	if (saved && saved.origin !== e.origin)
		throw new Error(`${e.ownerFile} holds the owner of ${saved.origin}, not ${e.origin}`);
	const [authenticator, second] = saved
		? saved.keys.map((k) => SoftAuthenticator.load(adminOrigin, k))
		: [new SoftAuthenticator(adminOrigin), new SoftAuthenticator(adminOrigin)];
	if (!authenticator || !second) throw new Error("two passkeys expected");
	const persist = (): void =>
		writeFileSync(e.ownerFile, JSON.stringify({ origin: e.origin, keys: [authenticator.save(), second.save()] }), {
			mode: 0o600,
		});
	// The server refuses a counter that goes backwards (a cloned key), so every signature is saved
	// at once: the next process starts from the counter the server last saw.
	for (const a of [authenticator, second]) {
		const get = a.get.bind(a);
		a.get = (options, origin) => {
			const response = get(options, origin);
			if (existsSync(e.ownerFile)) persist();
			return response;
		};
	}

	const target: DeployedTarget = {
		origin: e.origin,
		adminOrigin,
		mcpUrl: `${e.origin}/mcp`,
		authenticator,
		second,
		async issueSetupToken(): Promise<string> {
			// The outbox writes the parameter shortly after first boot.
			for (let i = 0; ; i++) {
				try {
					const { stdout } = await run("aws", [
						"ssm",
						"get-parameter",
						"--name",
						`/memory-anywhere-${e.stage}/setup-token`,
						"--with-decryption",
						"--query",
						"Parameter.Value",
						"--output",
						"text",
						"--profile",
						e.profile,
						"--region",
						e.region,
					]);
					return stdout.trim();
				} catch (err) {
					if (i === 20) throw new Error(`no setup token for ${e.stage}`, { cause: err });
					await sleep(15_000);
				}
			}
		},
		async owner(): Promise<Browser> {
			if (!saved) {
				const browser = await ownerSetup(target);
				persist();
				return browser;
			}
			const browser = new Browser(e.origin);
			const options = await browser.postJson(`${adminOrigin}/api/login/options`);
			const verified = await browser.postJson(
				`${adminOrigin}/api/login/verify`,
				authenticator.get(options.data as never),
			);
			if (verified.status !== 200) throw new Error(`owner sign-in: ${JSON.stringify(verified)}`);
			persist();
			return browser;
		},
	};
	return target;
}
