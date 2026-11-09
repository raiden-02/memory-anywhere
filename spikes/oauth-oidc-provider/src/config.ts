// Vendors and their redirect and CIMD rules (auth-and-security.md §4.2, §4.3). M0 records the
// exact values each vendor uses (Q01-Q04, Q10, Q11) in config/vendors.json; until then the hosts
// the spec already knows are listed and the others are left open for the owner to supply.

export type Vendor = "claude" | "chatgpt" | "gemini" | "grok" | "claude-code" | "pc" | "other";
export type Method = "static" | "cimd" | "dcr";

export interface VendorRule {
  label: string;
  /** Exact https redirect URIs the vendor is known to use (empty: recorded in M0). */
  redirects: string[];
  /** Hosts allowed for https redirect URIs in DCR. */
  redirectHosts: string[];
  /** Exact CIMD client_id URLs (host + path pattern). */
  cimd: RegExp[];
  methods: Method[];
  /** Loopback redirects allowed (any port on 127.0.0.1 / localhost). */
  loopback: boolean;
}

export const VENDORS: Record<Vendor, VendorRule> = {
  claude: {
    label: "Claude",
    redirects: ["https://claude.ai/api/mcp/auth_callback"],
    redirectHosts: ["claude.ai"],
    cimd: [], // hosted-Claude CIMD URL is recorded in M0 Q04
    methods: ["static", "cimd", "dcr"],
    loopback: false,
  },
  chatgpt: {
    label: "ChatGPT",
    redirects: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    redirectHosts: ["chatgpt.com"],
    cimd: [/^https:\/\/chatgpt\.com\/oauth\/client\.json$/, /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]{1,64}\/client\.json$/],
    methods: ["static", "cimd", "dcr"],
    loopback: false,
  },
  gemini: { label: "Gemini", redirects: [], redirectHosts: [], cimd: [], methods: ["static", "dcr"], loopback: false },
  grok: { label: "Grok", redirects: [], redirectHosts: [], cimd: [], methods: ["static", "cimd", "dcr"], loopback: false },
  "claude-code": {
    label: "Claude Code (direct)",
    redirects: [],
    redirectHosts: [],
    cimd: [/^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata$/],
    methods: ["cimd"],
    loopback: true,
  },
  pc: { label: "PC (mema login)", redirects: [], redirectHosts: [], cimd: [], methods: ["static"], loopback: true },
  other: { label: "Other", redirects: [], redirectHosts: [], cimd: [], methods: ["static", "dcr"], loopback: false },
};

export const SCOPES = ["memory.read", "memory.write", "memory.capture"] as const;
export const VENDOR_SCOPE = "memory.read memory.write";
export const PC_CLIENT_ID = "memory-anywhere-cli";
export const PAIRING_MINUTES = 10;
export const REFRESH_GRACE_SECONDS = 30;

export function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

/** Same URI ignoring the port, for loopback redirects (RFC 8252 §7.3; auth-and-security.md §4.5). */
export function loopbackMatches(registered: string, requested: string): boolean {
  if (!isLoopback(registered) || !isLoopback(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** CIMD client_id URL shape (auth-and-security.md §4.3): https, no userinfo, no port, no query, no fragment. */
export function cimdUrlShapeOk(id: string): boolean {
  try {
    const u = new URL(id);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && id === u.href;
  } catch {
    return false;
  }
}

export function cimdVendorFor(id: string): Vendor | undefined {
  if (!cimdUrlShapeOk(id)) return undefined;
  return (Object.keys(VENDORS) as Vendor[]).find((v) => VENDORS[v].cimd.some((re) => re.test(id)));
}
