// Secret detection and redaction (write-path.md §3, memory-policy.md §3.7). One implementation
// for client and server: the client redacts prompts before spooling or sending them, and the
// server re-checks every inbound text field. For memory_save a match is not redacted: the save is
// rejected (row D1) and the text is never stored or logged.

import { SECRET_RULES, type SecretRule } from "./generated/policy-data.ts";

export interface SecretMatch {
  /** Redaction label, e.g. `github_token`, `payment_card`, `high_entropy`. */
  readonly type: string;
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
}

interface CompiledRule {
  readonly rule: SecretRule;
  readonly re: RegExp;
  readonly near: RegExp | undefined;
}

const COMPILED: readonly CompiledRule[] = SECRET_RULES.map((rule) => ({
  rule,
  re: new RegExp(rule.pattern, `g${rule.flags ?? ""}`),
  near: rule.near ? new RegExp(rule.near.pattern, rule.near.flags ?? "") : undefined,
}));

/** Luhn checksum over the digits of `s` (spaces and dashes ignored). */
export function luhnValid(s: string): boolean {
  const digits = s.replace(/[ -]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN check: move the first four characters to the end, letters to numbers, mod 97 = 1. */
export function ibanValid(s: string): boolean {
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function characterClasses(token: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(token)).length;
}

function passesCheck(rule: SecretRule, text: string): boolean {
  if (rule.check === "luhn") return luhnValid(text);
  if (rule.check === "mod97") return ibanValid(text);
  return true;
}

function isNear(near: RegExp, window: number, text: string, start: number, end: number): boolean {
  return near.test(text.slice(Math.max(0, start - window), Math.min(text.length, end + window)));
}

/**
 * Every secret in `text`, sorted by position, without overlaps: at one position the earlier
 * listed rule wins, and a match that starts inside an earlier one is dropped.
 */
export function findSecrets(text: string): SecretMatch[] {
  const found: (SecretMatch & { order: number })[] = [];
  COMPILED.forEach(({ rule, re, near }, order) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!passesCheck(rule, m[0])) continue;
      if (near && rule.near && !isNear(near, rule.near.window, text, start, end)) continue;
      found.push({ type: rule.type, start, end, order });
    }
  });
  // Entropy rule: whitespace-free tokens of >= 20 characters, >= 4.0 bits/char, >= 3 classes.
  for (const m of text.matchAll(/\S{20,}/g)) {
    if (shannonEntropy(m[0]) >= 4.0 && characterClasses(m[0]) >= 3) {
      found.push({ type: "high_entropy", start: m.index, end: m.index + m[0].length, order: COMPILED.length });
    }
  }
  found.sort((a, b) => a.start - b.start || a.order - b.order || b.end - a.end);
  const result: SecretMatch[] = [];
  let covered = 0;
  for (const f of found) {
    if (f.start < covered) continue;
    result.push({ type: f.type, start: f.start, end: f.end });
    covered = f.end;
  }
  return result;
}

export function hasSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/** `text` with each secret replaced by `[REDACTED:<type>]`, and the types found, in order. */
export function redact(text: string): { text: string; types: string[] } {
  const matches = findSecrets(text);
  if (matches.length === 0) return { text, types: [] };
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + `[REDACTED:${m.type}]`;
    at = m.end;
  }
  return { text: out + text.slice(at), types: matches.map((m) => m.type) };
}

/** True when text contains a redaction marker; extracted capture candidates with one are dropped. */
export function containsRedactionMarker(text: string): boolean {
  return text.includes("[REDACTED:");
}
