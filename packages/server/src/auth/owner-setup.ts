// First-time setup on the admin origin (auth-and-security.md §3.1): with the setup token as proof, the
// owner enrolls two passkeys from different providers, gets recovery codes, types one back, and is
// signed in.
//
//   POST /setup/options   registration options for the next passkey
//   POST /setup/verify    stores the passkey; after the second, returns the recovery codes
//   POST /setup/confirm   checks one typed-back code, uses up the token, starts a session

import type { Reply } from "../web/pages.ts";
import { sha256Hex } from "./adapter.ts";
import type { OwnerCredentials } from "./owner.ts";
import { secondPasskeyOk, type Passkeys } from "./passkeys.ts";

export const SETUP_PATHS: ReadonlySet<string> = new Set(["/setup/options", "/setup/verify", "/setup/confirm"]);

export interface SetupEnv {
	readonly owner: OwnerCredentials;
	readonly passkeys: Passkeys;
	/** Starts the owner's session and replies with its cookie. */
	readonly signIn: (reply: Reply) => void;
}

export async function setupStep(
	{ owner, passkeys, signIn }: SetupEnv,
	path: string,
	body: Record<string, unknown>,
	reply: Reply,
): Promise<void> {
	const token = String(body["token"] ?? "");
	// Enrolling needs fewer than two passkeys; the final confirmation only needs the token itself.
	if (!(path === "/setup/confirm" ? owner.setupTokenUnused(token) : owner.setupTokenValid(token)))
		return reply(403, { error: "setup_unavailable" });
	const purpose = `setup:${sha256Hex(token).slice(0, 32)}`;
	if (path === "/setup/options") return reply(200, await passkeys.registrationOptions(purpose));
	if (path === "/setup/verify") {
		const p = await passkeys.verifyRegistration(purpose, body["response"] as never);
		if (!p) return reply(400, { error: "registration_failed" });
		const first = passkeys.list()[0];
		if (
			first &&
			!secondPasskeyOk(
				{ aaguid: first.aaguid, backupEligible: first.backup_eligible === 1 },
				p,
				body["differentProviders"] === true,
			)
		) {
			return reply(409, { error: "same_provider" });
		}
		owner.createOwner();
		passkeys.store(p, String(body["label"] ?? (first ? "Second passkey" : "First passkey")));
		if (!first) return reply(200, { next: "second_passkey" });
		return reply(200, { next: "confirm_code", codes: await owner.newRecoveryCodes() });
	}
	// confirm: two passkeys exist and the owner typed one recovery code back.
	if (passkeys.count() < 2 || !(await owner.checkRecoveryCode(String(body["code"] ?? ""), false)))
		return reply(403, { error: "code_mismatch" });
	owner.finishSetup(token);
	signIn(reply);
}
