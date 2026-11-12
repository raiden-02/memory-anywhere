// Client commands (config-and-cli.md §4.1, §4.2): status, sync, search, enable, disable, project
// track/add, review, export, version, connect, login, logout, ui. Owner commands go to
// /v1/admin/* with the local token in local mode (topology-and-ipc.md §4), and after the owner's
// passkey approval (step-up) in aws mode (stepup.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { CLIENT_TEXTS, POLICY_VERSION } from "@memory-anywhere/contracts/policy-data";
import type { RecallOutputT } from "@memory-anywhere/contracts/schemas/tools";
import type { ProjectionResponseT } from "@memory-anywhere/contracts/schemas/v1";
import { readRepos, writeProfile, writeRepoContext, writeRepoState } from "./cache.ts";
import { login as pcLogin, logout as pcLogout } from "./auth.ts";
import { CLIENT_VERSION, LOCAL_URL, type ClientConfigT } from "./config.ts";
import { unregisterAndStop } from "./local-server.ts";
import { NONE, repoIdentity } from "./repo-key.ts";
import { drain, spoolStats } from "./spool.ts";
import { adminCall, adminDownload } from "./stepup.ts";
import { StoreError, type StoreClient } from "./store-client.ts";

export interface CommandDeps {
  readonly paths: Paths;
  readonly config: ClientConfigT;
  readonly store: StoreClient;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly ask: (question: string, fallback: string) => Promise<string>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Opens a URL in the default browser; false when it could not. */
  readonly openBrowser: (url: string) => Promise<boolean>;
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
  const r = await adminCall<{ project_entity_id: string | null }>(d, "repo-enable", {
    repo_key: repo.repoKey, display_name: repo.displayName, capture: o.capture, ...(name ? { track: { name, repo_url: repo.remote ?? null } } : {}),
  });
  writeRepoState(d.paths, repo.repoKey, { enabled: true, capture: o.capture, root: repo.root, checked_at: new Date(d.now()).toISOString() });
  d.out(`enabled ${repo.displayName} (${repo.repoKey})${o.capture ? " with capture" : ""}${r?.project_entity_id ? `; tracked as project "${name ?? ""}"` : ""}`);
}

export async function disable(d: CommandDeps): Promise<void> {
  const repo = currentRepo(d);
  await adminCall(d, "repo-disable", { repo_key: repo.repoKey });
  writeRepoState(d.paths, repo.repoKey, { enabled: false, capture: false, root: repo.root, checked_at: new Date(d.now()).toISOString() });
  d.out(`disabled ${repo.displayName}`);
}

export async function projectTrack(d: CommandDeps, name: string | undefined, repoUrl: string | undefined): Promise<void> {
  const repo = currentRepo(d);
  await adminCall(d, "project-track", { repo_key: repo.repoKey, name: name ?? repo.displayName, repo_url: repoUrl ?? repo.remote ?? null });
  d.out(`tracking ${repo.displayName} as project "${name ?? repo.displayName}"`);
}

export async function projectAdd(d: CommandDeps, name: string, aliases: readonly string[], status: string | undefined, goal: string | undefined): Promise<void> {
  await adminCall(d, "project-add", { name, aliases: [...aliases], ...(status ? { status } : {}), ...(goal ? { goal } : {}) });
  d.out(`added project "${name}"`);
}

/** Without ids: pending items as ids, kinds and ages only, with no step-up (content is shown in the admin UI). */
export async function review(d: CommandDeps, approve: readonly string[], reject: readonly string[]): Promise<void> {
  type Review = { resolved: number; pending: { id: string; kind: string; created_at: string }[] };
  const args = { approve: [...approve], reject: [...reject] };
  const listing = approve.length + reject.length === 0;
  const r = listing ? await d.store.request<Review>("POST", "/v1/admin/review", args, TIMEOUT) : await adminCall<Review>(d, "review", args);
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

export interface ExportOptions {
  readonly out: string;
  readonly projects: boolean;
  readonly includeAuth: boolean;
  readonly recipient: string | undefined;
}

/**
 * `mema export` (data-model.md §10–§11): the whole store encrypted to an age key (the registered
 * one, or `--recipient`), or the project catalog as JSON. The file is written user-only, and an
 * existing file is never overwritten.
 */
export async function exportStore(d: CommandDeps, o: ExportOptions): Promise<void> {
  if (existsSync(o.out)) throw new Error(`${o.out} exists; choose another --out`);
  const args = o.projects ? { section: "projects", format: "json", include_auth: false } : { include_auth: o.includeAuth, ...(o.recipient ? { recipient: o.recipient } : {}) };
  const r = await adminDownload(d, "export", args);
  writeFileAtomic(o.out, r.bytes, { private: true });
  d.out(o.projects ? `wrote the project catalog to ${o.out}` : `wrote the encrypted store (${r.bytes.length} bytes, age) to ${o.out}`);
}

/** Writes `[store]` mode and url into client.toml, keeping every other key. */
function writeStore(paths: Paths, mode: "local" | "remote", url: string): void {
  const doc = existsSync(paths.clientConfigFile) ? (parseToml(readFileSync(paths.clientConfigFile, "utf8")) as Record<string, unknown>) : { schema: 1 };
  doc["store"] = { ...((doc["store"] as Record<string, unknown> | undefined) ?? {}), mode, url };
  mkdirSync(path.dirname(paths.clientConfigFile), { recursive: true });
  writeFileSync(paths.clientConfigFile, `${stringifyToml(doc)}\n`);
}

/**
 * `mema connect <url>`: sets the store in client.toml and checks /v1/health. Connecting a
 * local-mode PC to a remote store leaves local mode: the start at logon is removed and the local
 * server stopped; its store stays on disk as a backup.
 */
export async function connect(d: CommandDeps, url: string, fetchImpl: typeof fetch = fetch, stopLocal: typeof unregisterAndStop = unregisterAndStop): Promise<void> {
  const clean = url.replace(/\/+$/u, "");
  const local = clean === LOCAL_URL;
  if (!local && new URL(clean).protocol !== "https:") throw new Error("a remote store must use https");
  const health = await fetchImpl(`${clean}/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ ok?: boolean; version?: string }>);
  const wasLocal = d.config.store.mode === "local";
  writeStore(d.paths, local ? "local" : "remote", clean);
  d.out(`connected to ${clean} (server ${health.version ?? "?"}, ${health.ok ? "healthy" : "not healthy"})`);
  if (wasLocal && !local) leaveLocalMode(d, stopLocal);
  if (!local) d.out("next: run `mema login` to sign this PC in");
}

/** Stops the local server and its start at logon; the local store stays on disk as a backup. */
export function leaveLocalMode(d: Pick<CommandDeps, "paths" | "out">, stopLocal: typeof unregisterAndStop = unregisterAndStop): void {
  stopLocal(path.join(d.paths.localServerDataDir, "start-hidden.js"), d.paths.localServerConfigFile);
  d.out(`left local mode: the local server is stopped and no longer starts at logon; its store stays in ${d.paths.localServerDataDir} as a backup`);
}

/** `mema login` (auth-and-security.md §5.6). */
export async function login(d: CommandDeps, openBrowser: boolean, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (d.config.store.mode === "local" || !d.store.url) throw new Error("local mode needs no login; `mema connect <url>` a remote store first");
  const t = await pcLogin(d.store.url, { paths: d.paths, fetch: fetchImpl, now: d.now, sleep: d.sleep }, { out: d.out, openBrowser: d.openBrowser, machineName: os.hostname() }, openBrowser);
  d.out(`signed in to ${t.issuer}; this PC can now save and recall`);
}

/** `mema logout`: revokes the PC grant and deletes tokens.json. */
export async function logout(d: CommandDeps, fetchImpl: typeof fetch = fetch): Promise<void> {
  const r = await pcLogout({ paths: d.paths, fetch: fetchImpl, now: d.now, sleep: d.sleep });
  d.out(r === "revoked" ? "signed out; the store revoked this PC's access"
    : r === "deleted" ? "signed out on this PC; the store could not be reached, so also revoke the PC in the admin UI (Apps)"
    : "not signed in");
}

/** `mema ui`: the admin UI (aws mode: admin.{host}; local mode: a one-time login link). */
export async function ui(d: CommandDeps): Promise<void> {
  if (!d.store.url) throw new Error("no store configured; run `mema init`");
  let url: string;
  if (d.config.store.mode === "local") {
    const link = await d.store.request<{ url: string }>("POST", "/admin/link", undefined, TIMEOUT);
    if (!link) throw new StoreError("rejected", "the local server gave no link");
    url = link.url;
  } else {
    const store = new URL(d.store.url);
    url = `${store.protocol}//admin.${store.host}/`;
  }
  if (!(await d.openBrowser(url))) d.out(`open ${url}`);
}
