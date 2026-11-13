// `server.toml` (config-and-cli.md §5): one zod schema with every default. An unknown key or an
// invalid value stops the server with `file:line key: message`. Every number the spec names as
// tunable lives here, so code reads `config.observation.ttl_days`, never a literal.

import { parse } from "smol-toml";
import { z } from "zod";
import { SENSITIVE_CATEGORIES } from "../policy/generated.ts";

const ClientDefaults = z.strictObject({
  quota_saves_per_hour: z.int().min(1),
  quota_forgets_per_day: z.int().min(0),
  read_budget_1h: z.int().min(1),
  read_budget_24h: z.int().min(1),
});

export const ServerConfig = z.strictObject({
  schema: z.literal(1).default(1),
  server: z
    .strictObject({
      mode: z.enum(["aws", "local"]).default("local"),
      public_url: z.string().default(""),
      listen: z.string().default("127.0.0.1:47821"),
      data_dir: z.string().default(""),
      /** Local mode: where the local token is written (spec-issues #23). */
      local_token_file: z.string().default(""),
      /** Local mode: where the embedding model files are (spec-issues #23). */
      models_dir: z.string().default(""),
    })
    .default({ mode: "local", public_url: "", listen: "127.0.0.1:47821", data_dir: "", local_token_file: "", models_dir: "" }),
  owner: z.strictObject({ timezone: z.string().default("UTC") }).default({ timezone: "UTC" }),
  embedding: z
    .strictObject({ model: z.string().default(""), dtype: z.enum(["q4", "q8", "fp32"]).default("q4") })
    .default({ model: "", dtype: "q4" }),
  llm: z
    .strictObject({
      provider: z.enum(["anthropic", "openai", "none"]).default("none"),
      model: z.string().default(""),
      judge: z.boolean().default(false),
      daily_usd_cap: z.number().min(0).default(1),
      import_usd_cap: z.number().min(0).default(20),
    })
    .default({ provider: "none", model: "", judge: false, daily_usd_cap: 1, import_usd_cap: 20 }),
  write: z
    .strictObject({
      support_min: z.number().min(0).max(1).default(0.5),
      capture_support_min: z.number().min(0).max(1).default(0.6),
      event_default_ttl_days: z.int().min(1).default(30),
      event_max_ttl_days: z.int().min(1).default(90),
    })
    .default({ support_min: 0.5, capture_support_min: 0.6, event_default_ttl_days: 30, event_max_ttl_days: 90 }),
  observation: z
    .strictObject({
      ttl_days: z.int().min(1).default(60),
      promote_min_sessions: z.int().min(2).default(2),
      chat_session_gap_hours: z.number().min(0).default(6),
      max_open_per_client: z.int().min(1).default(500),
    })
    .default({ ttl_days: 60, promote_min_sessions: 2, chat_session_gap_hours: 6, max_open_per_client: 500 }),
  sections: z
    .strictObject({ max_active: z.int().min(1).default(16), max_new_per_run: z.int().min(0).default(2), min_members: z.int().min(2).default(3) })
    .default({ max_active: 16, max_new_per_run: 2, min_members: 3 }),
  recall: z
    .strictObject({
      default_limit: z.int().min(1).max(10).default(6),
      max_limit: z.int().min(1).max(10).default(10),
      max_chars: z.int().min(500).default(8000),
      profile_max_chars: z.int().min(500).default(6000),
    })
    .default({ default_limit: 6, max_limit: 10, max_chars: 8000, profile_max_chars: 6000 }),
  client_defaults: z
    .strictObject({ chat: ClientDefaults, coding: ClientDefaults })
    .default({
      chat: { quota_saves_per_hour: 20, quota_forgets_per_day: 5, read_budget_1h: 20, read_budget_24h: 60 },
      coding: { quota_saves_per_hour: 40, quota_forgets_per_day: 5, read_budget_1h: 60, read_budget_24h: 200 },
    }),
  sensitive: z
    .strictObject({ blocked: z.array(z.enum(SENSITIVE_CATEGORIES)).default([...SENSITIVE_CATEGORIES]), llm_check: z.boolean().default(true) })
    .default({ blocked: [...SENSITIVE_CATEGORIES], llm_check: true }),
  retention: z
    .strictObject({
      forgotten_purge_days: z.int().min(1).default(30),
      extraction_cache_days: z.int().min(1).default(30),
      resolved_review_days: z.int().min(1).default(30),
      audit_days: z.int().min(1).default(90),
      write_request_days: z.int().min(1).default(180),
      session_prompt_hours: z.int().min(1).default(24),
      pre_copy_hours: z.int().min(1).default(24),
    })
    .default({
      forgotten_purge_days: 30, extraction_cache_days: 30, resolved_review_days: 30, audit_days: 90, write_request_days: 180,
      session_prompt_hours: 24, pre_copy_hours: 24,
    }),
  deployment: z
    .strictObject({
      doh_url: z.string().default("https://cloudflare-dns.com/dns-query"),
      /** Eval stacks only (install.sh): the owner-authenticated selfcheck routes (spec-issues #57, #76). */
      selfcheck: z.boolean().default(false),
    })
    .default({ doh_url: "https://cloudflare-dns.com/dns-query", selfcheck: false }),
  rate_limits: z
    .strictObject({
      token_per_ip_per_min: z.int().min(1).default(10),
      register_per_ip_per_min: z.int().min(1).default(10),
      authorize_per_ip_per_min: z.int().min(1).default(20),
      login_per_ip_per_min: z.int().min(1).default(5),
      recover_per_ip_per_hour: z.int().min(1).default(5),
      mcp_per_grant_per_min: z.int().min(1).default(120),
      unauth_per_ip_per_min: z.int().min(1).default(30),
    })
    .default({
      token_per_ip_per_min: 10, register_per_ip_per_min: 10, authorize_per_ip_per_min: 20, login_per_ip_per_min: 5,
      recover_per_ip_per_hour: 5, mcp_per_grant_per_min: 120, unauth_per_ip_per_min: 30,
    }),
  alerts: z.strictObject({ sns_topic_arn: z.string().default(""), digest_hour_local: z.int().min(0).max(23).default(8) }).default({ sns_topic_arn: "", digest_hour_local: 8 }),
}).superRefine((c, ctx) => {
  // Each mode has one shape (topology-and-ipc.md §2, §4): local binds loopback only; aws serves
  // a unix socket behind Caddy and has a public https URL, which is also the OAuth issuer.
  const issue = (key: string, message: string): void => void ctx.addIssue({ code: "custom", path: ["server", key], message });
  if (c.server.mode === "local") {
    if (!/^127\.0\.0\.1:\d{1,5}$/u.test(c.server.listen)) issue("listen", "local mode listens on 127.0.0.1:<port> only");
  } else {
    if (!/^unix:\/\S+$/u.test(c.server.listen)) issue("listen", "aws mode listens on a unix socket: unix:/run/memory-anywhere/http.sock");
    if (!/^https:\/\/[a-z0-9.-]+$/u.test(c.server.public_url)) issue("public_url", "aws mode needs public_url = \"https://<host>\"");
    if (!c.server.data_dir) issue("data_dir", "aws mode needs data_dir");
  }
});

export type ServerConfigT = z.output<typeof ServerConfig>;

export type ListenTarget = { readonly kind: "tcp"; readonly port: number } | { readonly kind: "unix"; readonly path: string };

/** Where the server listens: a loopback port (local) or a unix socket (aws). */
export function listenTarget(config: ServerConfigT, portOverride?: number): ListenTarget {
  const { listen } = config.server;
  if (listen.startsWith("unix:")) return { kind: "unix", path: listen.slice("unix:".length) };
  const port = portOverride ?? Number(listen.split(":")[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError(`invalid port in server.listen ${listen}`);
  return { kind: "tcp", port };
}

/** The configuration with every default (local mode). */
export function defaultConfig(): ServerConfigT {
  return ServerConfig.parse({});
}

export class ConfigError extends Error {}

/** Parses `server.toml` text; errors name the file, line (when known) and key. */
export function parseConfig(text: string, file = "server.toml"): ServerConfigT {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    const line = (e as { line?: number }).line;
    throw new ConfigError(`${file}${line ? `:${line}` : ""}: ${(e as Error).message.split("\n")[0]}`);
  }
  const result = ServerConfig.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const key = issue?.path.join(".") ?? "";
  const line = key ? lineOfKey(text, issue?.path.at(-1)?.toString() ?? "") : undefined;
  throw new ConfigError(`${file}${line ? `:${line}` : ""} ${key}: ${issue?.message ?? "invalid"}`);
}

function lineOfKey(text: string, key: string): number | undefined {
  const i = text.split(/\r?\n/).findIndex((l) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(l));
  return i >= 0 ? i + 1 : undefined;
}
