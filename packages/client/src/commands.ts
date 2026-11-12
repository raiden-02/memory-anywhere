// Everyday client commands (config-and-cli.md §4.1, §4.2): status, sync, search, enable, disable,
// project track/add, review, version, connect. Owner commands go to /v1/admin/* with the local
// token in local mode (topology-and-ipc.md §4); step-up for aws mode arrives in M2.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { CLIENT_TEXTS, POLICY_VERSION } from "@memory-anywhere/contracts/policy-data";
import type { RecallOutputT } from "@memory-anywhere/contracts/schemas/tools";
import type { ProjectionResponseT } from "@memory-anywhere/contracts/schemas/v1";
import { readRepos, writeProfile, writeRepoContext, writeRepoState } from "./cache.ts";
import { CLIENT_VERSION, type ClientConfigT } from "./config.ts";
import { NONE, repoIdentity } from "./repo-key.ts";
import { drain, spoolStats } from "./spool.ts";
import { StoreError, type StoreClient } from "./store-client.ts";

export interface CommandDeps {
  readonly paths: Paths;
  readonly config: ClientConfigT;
  readonly store: StoreClient;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly ask: (question: string, fallback: string) => Promise<string>;
  readonly now: () => number;
}

const TIMEOUT = 10_000;

/** Throws a usage-level message for a repo that can never be enabled. */
function currentRepo(d: CommandDeps): ReturnType<typeof repoIdentity> {
  const repo = repoIdentity(d.cwd, d.config.repos.deny_remotes);
  if (repo.repoKey === NONE) throw new Error("this folder cannot be enabled: it is your home folder, a drive root, or on the deny-list");
  return repo;
}

export async function status(d: CommandDeps): Promise<void> {
  const spool = spoolStats(d.paths);
  try {
    const s = await d.store.request<{ store: string; health: string; policy_version_server: string; server_version: string }>("GET", "/v1/status", undefined, TIMEOUT);
    d.out(`store:   ${s?.store ?? "?"} (${d.store.url ?? "not configured"})`);
    d.out(`health:  ${s?.health ?? "?"}`);
    d.out(`policy:  ${s?.policy_version_server ?? "?"} (this client ${POLICY_VERSION})`);
    d.out(`server:  ${s?.server_version ?? "?"}; client ${CLIENT_VERSION}`);
  } catch (e) {
    d.out(`store:   unreachable (${(e as Error).message})`);
  }
  d.out(`spool:   ${spool.count} waiting`);
}

/** Drains the spool and refreshes the profile and every enabled repo's context. */
export async function sync(d: CommandDeps, quiet = false): Promise<void> {
  const drained = await drain(d.paths, d.store, d.now() + 30_000, d.now);
  const repos = Object.entries(readRepos(d.paths)).filter(([, s]) => s.enabled);
  let refreshed = 0;
  for (const [key, state] of repos.length > 0 ? repos : [["none", undefined] as const]) {
    const p = await d.store.request<ProjectionResponseT>("GET", `/v1/projection?repo_key=${encodeURIComponent(key)}`, undefined, TIMEOUT);
    if (!p) continue;
    writeProfile(d.paths, p.profile);
    if (state && p.repo_context !== null) writeRepoContext(d.paths, key, p.repo_context);
    refreshed++;
  }
  if (!quiet) d.out(`sent ${drained.sent} spooled writes; ${drained.remaining} remain; refreshed ${refreshed} caches`);
}

export async function search(d: CommandDeps, query: string, section: string | undefined, limit: number | undefined): Promise<void> {
  const repo = repoIdentity(d.cwd, d.config.repos.deny_remotes);
  const r = await d.store.request<RecallOutputT>("POST", "/v1/recall", { query, ...(section ? { section } : {}), ...(limit ? { limit } : {}), repo_key: repo.repoKey }, TIMEOUT, {
    repoKey: repo.repoKey, tool: "generic",
  });
  if (!r || r.items.length === 0) {
    d.out(r?.notice ?? "No stored memory matches.");
    return;
  }
  for (const i of r.items) d.out(`[${i.id}] (${i.kind} · ${i.section} · ${i.tier}${i.status === "contested" ? " · contested" : ""}) ${i.content}`);
}

export interface EnableOptions {
  readonly capture: boolean;
  readonly track: boolean | undefined;
}

/** `mema enable` and its registration prompt (memory-policy.md §10). */
export async function enable(d: CommandDeps, o: EnableOptions): Promise<void> {
  const repo = currentRepo(d);
  const track = o.track ?? /^y(es)?$/iu.test(await d.ask("Track this repo as a project? [Y/n]", "y"));
  const name = track ? (await d.ask(`Project name [${repo.displayName}]:`, repo.displayName)) || repo.displayName : undefined;
  const r = await d.store.request<{ project_entity_id: string | null }>("POST", "/v1/admin/repo-enable", {
    repo_key: repo.repoKey, display_name: repo.displayName, capture: o.capture, ...(name ? { track: { name, repo_url: repo.remote ?? null } } : {}),
  }, TIMEOUT);
  writeRepoState(d.paths, repo.repoKey, { enabled: true, capture: o.capture, root: repo.root, checked_at: new Date(d.now()).toISOString() });
  d.out(`enabled ${repo.displayName} (${repo.repoKey})${o.capture ? " with capture" : ""}${r?.project_entity_id ? `; tracked as project "${name ?? ""}"` : ""}`);
}

export async function disable(d: CommandDeps): Promise<void> {
  const repo = currentRepo(d);
  await d.store.request("POST", "/v1/admin/repo-disable", { repo_key: repo.repoKey }, TIMEOUT);
  writeRepoState(d.paths, repo.repoKey, { enabled: false, capture: false, root: repo.root, checked_at: new Date(d.now()).toISOString() });
  d.out(`disabled ${repo.displayName}`);
}

export async function projectTrack(d: CommandDeps, name: string | undefined, repoUrl: string | undefined): Promise<void> {
  const repo = currentRepo(d);
  await d.store.request("POST", "/v1/admin/project-track", { repo_key: repo.repoKey, name: name ?? repo.displayName, repo_url: repoUrl ?? repo.remote ?? null }, TIMEOUT);
  d.out(`tracking ${repo.displayName} as project "${name ?? repo.displayName}"`);
}

export async function projectAdd(d: CommandDeps, name: string, aliases: readonly string[], status: string | undefined, goal: string | undefined): Promise<void> {
  await d.store.request("POST", "/v1/admin/project-add", { name, aliases, ...(status ? { status } : {}), ...(goal ? { goal } : {}) }, TIMEOUT);
  d.out(`added project "${name}"`);
}

/** Without ids: pending items as ids, kinds and ages only (content is shown in the admin UI). */
export async function review(d: CommandDeps, approve: readonly string[], reject: readonly string[]): Promise<void> {
  const r = await d.store.request<{ resolved: number; pending: { id: string; kind: string; created_at: string }[] }>("POST", "/v1/admin/review", { approve, reject }, TIMEOUT);
  if (!r) return;
  if (r.resolved > 0) d.out(`resolved ${r.resolved}`);
  if (r.pending.length === 0) d.out("nothing waits for review");
  for (const p of r.pending) d.out(`${p.id}  ${p.kind.padEnd(18)}  ${Math.max(0, Math.round((d.now() - Date.parse(p.created_at)) / 86_400_000))} d`);
}

export async function version(d: CommandDeps): Promise<void> {
  let server = "unreachable";
  try {
    server = (await d.store.request<{ version: string }>("GET", "/v1/health", undefined, 2000))?.version ?? server;
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
  }
  d.out(`client ${CLIENT_VERSION}, policy ${POLICY_VERSION}, server ${server}`);
}

export function printCustomInstruction(d: CommandDeps): void {
  d.out("Claude, ChatGPT and Grok (custom instructions):");
  d.out(CLIENT_TEXTS["custom-instruction"]);
  d.out("");
  d.out("Gemini (Saved info):");
  d.out(CLIENT_TEXTS["custom-instruction-gemini"]);
}

/** `mema connect <url>`: sets store.url in client.toml and checks /v1/health. */
export async function connect(d: CommandDeps, url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const clean = url.replace(/\/+$/u, "");
  const health = await fetchImpl(`${clean}/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ ok?: boolean; version?: string }>);
  const text = existsSync(d.paths.clientConfigFile) ? readFileSync(d.paths.clientConfigFile, "utf8") : "schema = 1\n";
  const next = /^\s*url\s*=/mu.test(text) ? text.replace(/^(\s*url\s*=\s*).*$/mu, `$1${JSON.stringify(clean)}`) : `${text.trimEnd()}\n\n[store]\nurl = ${JSON.stringify(clean)}\n`;
  writeFileSync(d.paths.clientConfigFile, next);
  d.out(`connected to ${clean} (server ${health.version ?? "?"}, ${health.ok ? "healthy" : "not healthy"})`);
}
