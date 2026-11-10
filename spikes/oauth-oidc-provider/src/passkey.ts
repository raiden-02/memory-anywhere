// Owner passkeys (auth-and-security.md §3.2) with @simplewebauthn/server: user verification
// required, resident key required, attestation none, ES256/EdDSA/RS256, single-use 2-minute
// challenges. The spike enrols one passkey at /setup (the product requires two, §3.1 step 3).

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

const CHALLENGE_MS = 2 * 60_000;
const ALGORITHMS = [-7, -8, -257]; // ES256, EdDSA, RS256

export class Passkeys {
  private readonly db: DatabaseSync;
  private readonly rpID: string;
  private readonly origins: string[];

  constructor(db: DatabaseSync, rpID: string, origins: string[]) {
    this.db = db;
    this.rpID = rpID;
    this.origins = origins;
  }

  count(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM passkey").get() as { n: number }).n);
  }

  /** Raw bytes for the options (the library base64url-encodes them); the stored value is that encoding. */
  private issueChallenge(purpose: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(randomBytes(32));
    this.db.prepare("INSERT INTO challenge (value, purpose, expires_at) VALUES (?, ?, ?)").run(Buffer.from(bytes).toString("base64url"), purpose, Date.now() + CHALLENGE_MS);
    return bytes;
  }

  /** Single use: a challenge is deleted whether or not it matches. */
  private consumeChallenge(purpose: string) {
    return (challenge: string): boolean => {
      const row = this.db.prepare("DELETE FROM challenge WHERE value = ? AND purpose = ? RETURNING expires_at").get(challenge, purpose) as
        | { expires_at: number }
        | undefined;
      return !!row && row.expires_at > Date.now();
    };
  }

  async registrationOptions() {
    return generateRegistrationOptions({
      rpName: "memory-anywhere",
      rpID: this.rpID,
      userName: "owner",
      userID: new TextEncoder().encode("owner"),
      challenge: this.issueChallenge("register"),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
      excludeCredentials: (this.db.prepare("SELECT id FROM passkey").all() as { id: string }[]).map((r) => ({ id: r.id })),
    });
  }

  async register(response: RegistrationResponseJSON): Promise<boolean> {
    let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      v = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.consumeChallenge("register"),
        expectedOrigin: this.origins,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch {
      return false;
    }
    if (!v.verified) return false;
    const c = v.registrationInfo.credential;
    this.db
      .prepare("INSERT INTO passkey (id, public_key, counter, aaguid, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.id, Buffer.from(c.publicKey), c.counter, v.registrationInfo.aaguid, v.registrationInfo.credentialBackedUp ? 1 : 0, Date.now());
    return true;
  }

  async assertionOptions(purpose: string) {
    return generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: this.issueChallenge(purpose),
      userVerification: "required",
      allowCredentials: (this.db.prepare("SELECT id FROM passkey").all() as { id: string }[]).map((r) => ({ id: r.id })),
    });
  }

  /** A user-verified assertion for `purpose` (admin login, step-up, consent). */
  async verify(purpose: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const row = this.db.prepare("SELECT id, public_key, counter FROM passkey WHERE id = ?").get(response.id) as
      | { id: string; public_key: Uint8Array; counter: number }
      | undefined;
    if (!row) return false;
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.consumeChallenge(purpose),
        expectedOrigin: this.origins,
        expectedRPID: this.rpID,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter },
        requireUserVerification: true,
      });
      if (!v.verified) return false;
      this.db.prepare("UPDATE passkey SET counter = ? WHERE id = ?").run(v.authenticationInfo.newCounter, row.id);
      return true;
    } catch {
      return false;
    }
  }
}
