// The apps that can connect, and what each may register with (auth-and-security.md §4.2–§4.4;
// clients.md §2). Redirects and CIMD URLs come from `config/vendors.json`, which M0 recorded from
// each vendor's real requests; the policy each new client gets comes from clients.md §2.
//
//   vendor               registration       redirect rule                         policy
//   claude               static → dcr       claude.ai callback                    chat, all sections
//   chatgpt              static → cimd/dcr  chatgpt.com callback                  chat, all sections
//   gemini               static → dcr       Google's per-user rule (ADR-0107)     chat, 4 sections, observation floor, fixed refresh
//   grok                 dcr                grok.com callback                     chat, 4 sections, observation floor
//   claude_code_direct   cimd               loopback                              chat, 4 sections, observation floor
//   pc                   built-in client    loopback                              coding (one policy per machine)
//   other                static or dcr      the https host the owner typed        chat, 4 sections, observation floor

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Vendor = "claude" | "chatgpt" | "gemini" | "grok" | "claude_code_direct" | "pc" | "other";
export type Method = "static" | "cimd" | "dcr";

export const VENDOR_IDS: readonly Vendor[] = ["claude", "chatgpt", "gemini", "grok", "claude_code_direct", "pc", "other"];

/** The PC's public client, pre-registered: `mema login` uses it with a loopback redirect (§5.6). */
export const PC_CLIENT_ID = "memory-anywhere-cli";
export const VENDOR_SCOPE = "memory.read memory.write";
export const PC_SCOPE = "memory.read memory.write memory.capture";
/** The sections a restricted client reads (clients.md §2: "sections as Gemini"). */
export const RESTRICTED_SECTIONS = ["sec_profile", "sec_preferences", "sec_interests", "sec_tools"] as const;

export interface VendorRule {
  readonly label: string;
  /** Registration methods, default first. */
  readonly methods: readonly Method[];
  /** Exact https redirect URIs. */
  readonly redirects: readonly string[];
  /** A redirect matched by rule instead of exactly (Gemini's per-user redirect). */
  readonly redirectRule?: (host: string) => RegExp;
  /** CIMD client_id URLs (exact). */
  readonly cimd: readonly RegExp[];
  /** Loopback redirects allowed (any port on 127.0.0.1 or localhost). */
  readonly loopback: boolean;
  readonly policy: {
    readonly clientClass: "chat" | "coding";
    readonly sections: "all" | "restricted";
    readonly saveFloor: "none" | "observation";
    readonly refreshRotation: "rotate" | "fixed";
  };
}

const VENDORS_FILE = fileURLToPath(new URL("../../../../config/vendors.json", import.meta.url));

interface VendorsJson {
  readonly chat: Record<string, { oauth?: { redirect_uris?: string[]; cimd_client_id_patterns?: string[]; redirect_uri_rule?: { regex_template: string } } }>;
}

function load(): Record<Vendor, VendorRule> {
  const chat = (JSON.parse(readFileSync(VENDORS_FILE, "utf8")) as VendorsJson).chat;
  const oauth = (v: string) => chat[v]?.oauth ?? {};
  const redirects = (v: string): string[] => oauth(v).redirect_uris ?? [];
  const cimd = (v: string): RegExp[] => (oauth(v).cimd_client_id_patterns ?? []).map((p) => new RegExp(p, "u"));
  const geminiTemplate = oauth("gemini").redirect_uri_rule?.regex_template;
  if (!geminiTemplate) throw new Error("config/vendors.json: gemini.oauth.redirect_uri_rule.regex_template is missing");
  const chatAll = { clientClass: "chat", sections: "all", saveFloor: "none", refreshRotation: "rotate" } as const;
  const chatRestricted = { clientClass: "chat", sections: "restricted", saveFloor: "observation", refreshRotation: "rotate" } as const;
  return {
    claude: { label: "Claude", methods: ["static", "dcr"], redirects: redirects("claude"), cimd: [], loopback: false, policy: chatAll },
    // CIMD: the URL ChatGPT used in M0, plus the per-app shape §4.3 also allows.
    chatgpt: {
      label: "ChatGPT", methods: ["static", "cimd", "dcr"], redirects: redirects("chatgpt"),
      cimd: [...cimd("chatgpt"), /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]{1,64}\/client\.json$/u], loopback: false, policy: chatAll,
    },
    gemini: {
      label: "Gemini",
      methods: ["static", "dcr"],
      redirects: [],
      redirectRule: (host) => new RegExp(geminiTemplate.replace("{host_underscored}", host.replaceAll(".", "_").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), "u"),
      cimd: [],
      loopback: false,
      policy: { ...chatRestricted, refreshRotation: "fixed" },
    },
    grok: { label: "Grok", methods: ["dcr"], redirects: redirects("grok"), cimd: [], loopback: false, policy: chatRestricted },
    claude_code_direct: {
      label: "Claude Code (direct)",
      methods: ["cimd"],
      redirects: [],
      cimd: [/^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata$/u],
      loopback: true,
      policy: chatRestricted,
    },
    pc: { label: "PC", methods: ["static"], redirects: [], cimd: [], loopback: true, policy: { clientClass: "coding", sections: "all", saveFloor: "none", refreshRotation: "rotate" } },
    other: { label: "Other", methods: ["static", "dcr"], redirects: [], cimd: [], loopback: false, policy: chatRestricted },
  };
}

export const VENDORS: Readonly<Record<Vendor, VendorRule>> = load();

export const isVendor = (v: unknown): v is Vendor => typeof v === "string" && (VENDOR_IDS as readonly string[]).includes(v);

export function isLoopback(uri: string): boolean {
  const u = URL.parse(uri);
  return !!u && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
}

/** Same URI ignoring the port, for loopback redirects (RFC 8252 §7.3; auth-and-security.md §4.5). */
export function loopbackMatches(registered: string, requested: string): boolean {
  if (!isLoopback(registered) || !isLoopback(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** CIMD client_id URL shape (§4.3): https, no userinfo, no port, no query, no fragment. */
export function cimdUrlShapeOk(id: string): boolean {
  const u = URL.parse(id);
  return !!u && u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && id === u.href;
}

export function cimdVendorFor(id: string): Vendor | undefined {
  if (!cimdUrlShapeOk(id)) return undefined;
  return VENDOR_IDS.find((v) => VENDORS[v].cimd.some((re) => re.test(id)));
}

/** An https URI on exactly `host`, with no userinfo or fragment. */
export function httpsOnHost(uri: string, host: string): boolean {
  const u = URL.parse(uri);
  return !!u && u.protocol === "https:" && u.hostname === host && !u.username && !u.password && !u.hash;
}
