// The PC login code (auth-and-security.md §5.6, spec-issues #61): `mema login` prints it and the
// consent page shows it, so the owner can check that the request they approve is the one their
// terminal started. Both sides derive it from the request's PKCE code_challenge, which each of
// them already has, so nothing extra travels in the authorization request.

import { createHash } from "node:crypto";

/** Crockford base32 (no I, L, O, U): easy to compare by eye. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The first 8 Crockford base32 characters of sha256(code_challenge). */
export function loginCode(codeChallenge: string): string {
  const digest = createHash("sha256").update(codeChallenge).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff; // at most 12 bits are pending at any time
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 8) break;
  }
  return out;
}
