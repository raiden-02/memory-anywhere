// A small unified diff (lines, 3 lines of context) for showing what `mema init` will change in a
// user's config files before it changes them (clients.md §6).

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** Line operations from a longest-common-subsequence table (config files are small). */
function ops(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] = a[i] === b[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if (i < n && (j === m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) out.push({ kind: "-", line: a[i++] as string });
    else out.push({ kind: "+", line: b[j++] as string });
  }
  return out;
}

/** `--- a/<label>` / `+++ b/<label>` and @@ hunks; empty when the texts are equal. */
export function unifiedDiff(label: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.replace(/\n$/u, "").split("\n");
  const b = after.replace(/\n$/u, "").split("\n");
  const all = ops(a, b);
  const changed = all.map((o, k) => (o.kind !== " " ? k : -1)).filter((k) => k >= 0);
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(all.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of hunks) {
    const before0 = all.slice(0, start).filter((o) => o.kind !== "+").length;
    const after0 = all.slice(0, start).filter((o) => o.kind !== "-").length;
    const body = all.slice(start, end + 1);
    lines.push(`@@ -${before0 + 1},${body.filter((o) => o.kind !== "+").length} +${after0 + 1},${body.filter((o) => o.kind !== "-").length} @@`);
    for (const o of body) lines.push(`${o.kind}${o.line}`);
  }
  return `${lines.join("\n")}\n`;
}
