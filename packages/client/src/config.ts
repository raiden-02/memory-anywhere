// `client.toml` (config-and-cli.md §6) and the client's version. Unknown keys are reported, not
// fatal: a client must keep working when a newer version wrote keys it does not know.

import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { currentPaths, type Paths } from "@memory-anywhere/contracts/paths";
import pkg from "../package.json" with { type: "json" };

export const CLIENT_VERSION: string = pkg.version;
export const LOCAL_URL = "http://127.0.0.1:47821";

const ClientConfig = z.object({
  schema: z.literal(1).default(1),
  store: z.object({ mode: z.enum(["remote", "local"]).default("remote"), url: z.string().default("") }).default({ mode: "remote", url: "" }),
  repos: z.object({ deny_remotes: z.array(z.string()).default([]) }).default({ deny_remotes: [] }),
  network: z
    .object({
      session_start_timeout_ms: z.int().min(100).default(1500),
      save_timeout_ms: z.int().min(100).default(8000),
      call_timeout_ms: z.int().min(100).default(5000),
    })
    .default({ session_start_timeout_ms: 1500, save_timeout_ms: 8000, call_timeout_ms: 5000 }),
  spool: z.object({ max_bytes: z.int().min(1).default(10_485_760), max_age_days: z.int().min(1).default(30) }).default({ max_bytes: 10_485_760, max_age_days: 30 }),
  log: z.object({ level: z.enum(["error", "warn", "info", "debug"]).default("info") }).default({ level: "info" }),
});
export type ClientConfigT = z.infer<typeof ClientConfig>;

export interface LoadedConfig {
  readonly config: ClientConfigT;
  /** Keys this version does not know (printed by `mema doctor`). */
  readonly unknownKeys: readonly string[];
}

function unknownKeys(raw: unknown, shape: z.ZodType, prefix = ""): string[] {
  if (typeof raw !== "object" || raw === null || !(shape instanceof z.ZodObject || shape instanceof z.ZodDefault)) return [];
  const obj = shape instanceof z.ZodDefault ? (shape.unwrap() as z.ZodType) : shape;
  if (!(obj instanceof z.ZodObject)) return [];
  const known = obj.shape as Record<string, z.ZodType>;
  return Object.entries(raw).flatMap(([k, v]) => (k in known ? unknownKeys(v, known[k] as z.ZodType, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

export function parseClientConfig(text: string): LoadedConfig {
  const raw = parse(text);
  return { config: ClientConfig.parse(raw), unknownKeys: unknownKeys(raw, ClientConfig) };
}

export function loadClientConfig(paths: Paths = currentPaths()): LoadedConfig {
  if (!existsSync(paths.clientConfigFile)) return { config: ClientConfig.parse({}), unknownKeys: [] };
  return parseClientConfig(readFileSync(paths.clientConfigFile, "utf8"));
}

/** The store URL: MA_STORE_URL, else client.toml, else the local server in local mode. */
export function storeUrl(config: ClientConfigT, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env["MA_STORE_URL"] || config.store.url || (config.store.mode === "local" ? LOCAL_URL : "");
  return url ? url.replace(/\/+$/u, "") : undefined;
}

/** client.toml text for a fresh install: local mode, or a remote store at `url`. */
export function clientToml(mode: "local" | "remote", url: string, denyRemotes: readonly string[] = []): string {
  return [
    "schema = 1",
    "",
    "[store]",
    `mode = "${mode}"`,
    `url = ${JSON.stringify(url)}`,
    "",
    "[repos]",
    `deny_remotes = ${JSON.stringify(denyRemotes)}`,
    "",
  ].join("\n");
}