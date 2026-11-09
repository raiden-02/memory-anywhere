// A software WebAuthn authenticator for the conformance tests: one ES256 (P-256) credential,
// "none" attestation, user presence and user verification always set. It produces exactly the
// JSON a browser's credential.toJSON() would, so the server code under test is unchanged.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

/** Minimal CBOR encoder: unsigned and negative integers, byte strings, text strings, maps. */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const t = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, t.length), t]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  private readonly origin: string;
  private credentialId: Buffer | undefined;
  private privateKey: KeyObject | undefined;
  private counter = 0;

  constructor(origin: string) {
    this.origin = origin;
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  private authData(rpId: string, flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() for PublicKeyCredentialCreationOptionsJSON. */
  create(options: { challenge: string; rp: { id?: string } }): Record<string, unknown> {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKey = privateKey;
    this.credentialId = randomBytes(16);
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cose]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(rpId, FLAG_UP | FLAG_UV | FLAG_AT, attested)],
      ]),
    );
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() for PublicKeyCredentialRequestOptionsJSON. */
  get(options: { challenge: string; rpId?: string }): Record<string, unknown> {
    if (!this.credentialId || !this.privateKey) throw new Error("no credential enrolled");
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const authenticatorData = this.authData(rpId, FLAG_UP | FLAG_UV);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: b64u(Buffer.from("owner")) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
