// The owner's passkeys (auth-and-security.md §3.1–§3.2), with @simplewebauthn/server.
//
// A passkey is a key pair: the private half stays on the owner's device; the server keeps the
// public half and checks each signature over a fresh challenge. Parameters: RP ID {host}, origins
// admin.{host} and {host}, user verification required, resident key required, attestation none,
// ES256/EdDSA/RS256, challenges of 32 random bytes that are single use, live 2 minutes and are
// bound to what asked for them.
//
// Clone check (spec-issues #55): a synced passkey reports a sign count that stays 0, so a count is
// only checked once it has been above 0; after that, a count that does not increase means a
// second copy of the key exists, and the credential is blocked with alert `passkey_clone`.

import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Alerts } from "../ops/alerts.ts";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

const CHALLENGE_MS = 2 * 60_000;
const ALGORITHMS = [-7, -8, -257]; // ES256, EdDSA, RS256
const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";

export interface PasskeyRow {
  readonly id: string;
  readonly aaguid: string;
  readonly backup_eligible: number;
  readonly label: string;
}

export class Passkeys {
  readonly #ctx: StoreContext;
  readonly #alerts: Alerts;
  readonly #rpID: string;
  readonly #origins: string[];

  /** `rpID` is {host}; `origins` the pages a ceremony may come from (admin.{host} and {host}). */
  constructor(ctx: StoreContext, alerts: Alerts, rpID: string, origins: string[]) {
    this.#ctx = ctx;
    this.#alerts = alerts;
    this.#rpID = rpID;
    this.#origins = origins;
  }

  /** Usable passkeys: not revoked, not blocked. */
  list(): PasskeyRow[] {
    return prepared(this.#ctx.db, "SELECT id, aaguid, backup_eligible, label FROM passkey WHERE revoked_at IS NULL AND blocked_at IS NULL ORDER BY created_at").all() as unknown as PasskeyRow[];
  }

  count(): number {
    return this.list().length;
  }

  #issueChallenge(purpose: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(randomBytes(32));
    prepared(this.#ctx.db, "INSERT INTO webauthn_challenge (value, purpose, expires_at) VALUES (?, ?, ?)")
      .run(Buffer.from(bytes).toString("base64url"), purpose, iso(this.#ctx.clock.now() + CHALLENGE_MS));
    return bytes;
  }

  /** Single use: a challenge is deleted whether or not it matches, and must be unexpired and for this purpose. */
  #consumeChallenge(purpose: string): (challenge: string) => boolean {
    return (challenge) => {
      const row = prepared(this.#ctx.db, "DELETE FROM webauthn_challenge WHERE value = ? RETURNING purpose, expires_at").get(challenge) as
        | { purpose: string; expires_at: string }
        | undefined;
      return !!row && row.purpose === purpose && row.expires_at > iso(this.#ctx.clock.now());
    };
  }

  async registrationOptions(purpose: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: "memory-anywhere",
      rpID: this.#rpID,
      userName: "owner",
      userID: new TextEncoder().encode("owner"),
      challenge: this.#issueChallenge(purpose),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
      excludeCredentials: (prepared(this.#ctx.db, "SELECT credential_id FROM passkey WHERE revoked_at IS NULL").all() as { credential_id: string }[]).map((r) => ({ id: r.credential_id })),
    });
  }

  /** Verifies a registration; returns the new credential's details, not yet stored. */
  async verifyRegistration(purpose: string, response: RegistrationResponseJSON): Promise<NewPasskey | undefined> {
    try {
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.#consumeChallenge(purpose),
        expectedOrigin: this.#origins,
        expectedRPID: this.#rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
      if (!v.verified) return undefined;
      const c = v.registrationInfo.credential;
      return {
        credentialId: c.id,
        publicKey: Buffer.from(c.publicKey),
        signCount: c.counter,
        transports: c.transports ?? [],
        backupEligible: v.registrationInfo.credentialDeviceType === "multiDevice",
        aaguid: v.registrationInfo.aaguid,
      };
    } catch {
      return undefined;
    }
  }

  store(p: NewPasskey, label: string): string {
    const { db, clock, ids } = this.#ctx;
    const id = ids.newId("pky", clock.now());
    prepared(db, `INSERT INTO passkey (id, credential_id, public_key, sign_count, transports_json, backup_eligible, aaguid, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, p.credentialId, p.publicKey, p.signCount, JSON.stringify(p.transports), p.backupEligible ? 1 : 0, p.aaguid, label.slice(0, 64), iso(clock.now()));
    return id;
  }

  async assertionOptions(purpose: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.#rpID,
      challenge: this.#issueChallenge(purpose),
      userVerification: "required",
      allowCredentials: (prepared(this.#ctx.db, "SELECT credential_id FROM passkey WHERE revoked_at IS NULL AND blocked_at IS NULL").all() as { credential_id: string }[])
        .map((r) => ({ id: r.credential_id })),
    });
  }

  /** A user-verified assertion for `purpose`; returns the passkey id that signed it. */
  async verify(purpose: string, response: AuthenticationResponseJSON): Promise<string | undefined> {
    const { db, clock } = this.#ctx;
    const row = prepared(db, "SELECT id, credential_id, public_key, sign_count FROM passkey WHERE credential_id = ? AND revoked_at IS NULL AND blocked_at IS NULL")
      .get(response.id) as { id: string; credential_id: string; public_key: Uint8Array; sign_count: number } | undefined;
    if (!row) return undefined;
    let newCount: number;
    try {
      // The library's own counter check is turned off (counter 0): the rule below decides, so it can block and alert.
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.#consumeChallenge(purpose),
        expectedOrigin: this.#origins,
        expectedRPID: this.#rpID,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: 0 },
        requireUserVerification: true,
      });
      if (!v.verified) return undefined;
      newCount = v.authenticationInfo.newCounter;
    } catch {
      return undefined;
    }
    if (row.sign_count > 0 && newCount <= row.sign_count) {
      prepared(db, "UPDATE passkey SET blocked_at = ? WHERE id = ?").run(iso(clock.now()), row.id);
      this.#alerts.raise("passkey_clone", { passkey: row.id });
      return undefined;
    }
    prepared(db, "UPDATE passkey SET sign_count = ?, last_used_at = ? WHERE id = ?").run(newCount, iso(clock.now()), row.id);
    return row.id;
  }
}

export interface NewPasskey {
  readonly credentialId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly backupEligible: boolean;
  readonly aaguid: string;
}

/**
 * Whether a second passkey is independent enough of the first (§3.1 step 3, spec-issues #55):
 * different known providers, or one of them device-bound. Otherwise (the same provider, or an
 * unknown one) only the owner's confirmation that they live with different providers will do.
 */
export function secondPasskeyOk(first: { aaguid: string; backupEligible: boolean }, second: { aaguid: string; backupEligible: boolean }, ownerConfirmed: boolean): boolean {
  if (!first.backupEligible || !second.backupEligible) return true;
  const known = first.aaguid !== ZERO_AAGUID && second.aaguid !== ZERO_AAGUID;
  if (known && first.aaguid !== second.aaguid) return true;
  return ownerConfirmed;
}
