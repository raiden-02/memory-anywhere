// Public DNS checks over DNS-over-HTTPS (deployment-aws.md §6.2, §6.3).
//
// A name is "ready" only when it resolves to exactly the Elastic IP. A
// Cloudflare address means the record is proxied (orange cloud), which would end
// TLS at Cloudflare, so it is reported as an error, never accepted.

export type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";

// https://www.cloudflare.com/ips-v4 (checked 2026-11-08)
const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256 + Number(p);
  }
  return n;
}

export function isCloudflareIp(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) return false;
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const b = ipv4ToInt(base ?? "");
    const size = 2 ** (32 - Number(bits));
    return b !== undefined && n >= b && n < b + size;
  });
}

/** A records for `name`, sorted; [] when the name does not exist. */
export async function resolveA(fetchFn: Fetch, name: string, doh = DEFAULT_DOH): Promise<string[]> {
  const url = `${doh}?name=${encodeURIComponent(name)}&type=A`;
  const res = await fetchFn(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DoH lookup of ${name} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
  if (body.Status === 3) return []; // NXDOMAIN
  return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data).sort();
}

export type NameState = { kind: "ready" } | { kind: "missing" } | { kind: "proxied"; ips: string[] } | { kind: "wrong"; ips: string[] };

export function classifyName(ips: string[], elasticIp: string): NameState {
  if (ips.length === 0) return { kind: "missing" };
  if (ips.some(isCloudflareIp)) return { kind: "proxied", ips };
  if (ips.length === 1 && ips[0] === elasticIp) return { kind: "ready" };
  return { kind: "wrong", ips };
}
