// M0 Q15 rule "≤ 400 lines of adapter code": counts code lines (non-blank, not comment-only) of
// the OAuth spike, split into the adapter (code that exists only to fit node-oidc-provider) and
// the rest (pairing, passkeys, consent and pages are memory-anywhere code with either library,
// auth-and-security.md §5.1).
//
//   node spikes/oauth-oidc-provider/count-adapter.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "src");
const code = (t: string): number =>
  t.split(/\r?\n/).filter((l) => {
    const s = l.trim();
    return s !== "" && !s.startsWith("//") && !s.startsWith("/*") && !s.startsWith("*");
  }).length;
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");
/** The text from marker `from` up to marker `to` (or the end); throws if a marker moved. */
function between(text: string, from: string, to?: string): string {
  const a = text.indexOf(from);
  const b = to === undefined ? text.length : text.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${a < 0 ? from : to}`);
  return text.slice(a, b);
}

const app = read("app.ts");
const adapter: [string, number][] = [
  ["provider.ts (library configuration)", code(read("provider.ts"))],
  ["db.ts Adapter class", code(between(read("db.ts"), "/** oidc-provider adapter"))],
  ["app.ts gates, mount, discovery, events", code(between(app, "// ---- gates", "// ---- owner sessions"))],
  ["app.ts PROVIDER_ROUTES", code(between(app, "/** The provider routes that may answer", "function cookies("))],
];
let total = 0;
console.log("adapter code (exists only because the library is node-oidc-provider):");
for (const [what, n] of adapter) {
  console.log(`${String(n).padStart(5)}  ${what}`);
  total += n;
}
console.log(`${String(total).padStart(5)}  TOTAL adapter (limit 400)\n\nwhole spike, per file:`);
let all = 0;
for (const f of readdirSync(SRC).sort()) {
  const n = code(read(f));
  all += n;
  console.log(`${String(n).padStart(5)}  ${f}`);
}
console.log(`${String(all).padStart(5)}  TOTAL spike`);
