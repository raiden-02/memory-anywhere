// The one place that decides where memory-anywhere keeps files on a machine
// (config-and-cli.md §3). Pure: every input is a parameter, so tests can ask
// "what would Windows/macOS/Linux do?" from any OS.
//
// Rules from the spec:
// - Never derive paths from the Documents folder (OneDrive redirects it).
// - MA_HOME, when set, replaces both the data root and the config root.
// - Every path must survive spaces; callers pass these to child processes as
//   separate argv entries, never through a shell string.

import os from "node:os";
import path from "node:path";

export type Platform = "win32" | "darwin" | "linux";

export interface PathInputs {
  platform: Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

export interface Paths {
  /** `{data}`: tokens, spool, caches, logs, dev release key. */
  dataDir: string;
  /** Holds client.toml, server.toml (local mode) and deploy.toml. */
  configDir: string;
  clientConfigFile: string;
  deployConfigFile: string;
  localServerDataDir: string;
  localServerConfigFile: string;
  /** Private half of the dev minisign key (deployment-aws.md §7.4). Never committed. */
  devReleaseKeyFile: string;
  logsDir: string;
  /** PC grant (aws mode) and its lock (topology-and-ipc.md §10). */
  tokensFile: string;
  tokensLock: string;
  /** Local-mode owner credential, written by the local server at first start (spec-issues #23). */
  localTokenFile: string;
  /** Writes waiting for the server (topology-and-ipc.md §9). */
  spoolDir: string;
  spoolDeadDir: string;
  spoolDrainLock: string;
  spoolRejectedLog: string;
  /** profile.md, repo-<key>.md, repos.json, tools.json (clients.md §5). */
  cacheDir: string;
  /** Hook errors only, never prompt text (clients.md §3.1). */
  hooksLog: string;
  /** Embedding model files, local mode only (retrieval.md §10). */
  modelsDir: string;
}

const APP = "memory-anywhere";

export function resolvePaths({ platform, env, home }: PathInputs): Paths {
  const p = platform === "win32" ? path.win32 : path.posix;
  const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() !== "" ? v : undefined);

  let dataDir: string;
  let configDir: string;
  const maHome = nonEmpty(env["MA_HOME"]);
  if (maHome) {
    dataDir = p.resolve(maHome);
    configDir = dataDir;
  } else if (platform === "win32") {
    const local = nonEmpty(env["LOCALAPPDATA"]) ?? p.join(home, "AppData", "Local");
    const roaming = nonEmpty(env["APPDATA"]) ?? p.join(home, "AppData", "Roaming");
    dataDir = p.join(local, APP);
    configDir = p.join(roaming, APP);
  } else if (platform === "darwin") {
    dataDir = p.join(home, "Library", "Application Support", APP);
    configDir = dataDir;
  } else {
    dataDir = p.join(nonEmpty(env["XDG_DATA_HOME"]) ?? p.join(home, ".local", "share"), APP);
    configDir = p.join(nonEmpty(env["XDG_CONFIG_HOME"]) ?? p.join(home, ".config"), APP);
  }

  return {
    dataDir,
    configDir,
    clientConfigFile: p.join(configDir, "client.toml"),
    deployConfigFile: p.join(configDir, "deploy.toml"),
    localServerDataDir: p.join(dataDir, "server"),
    localServerConfigFile: p.join(configDir, "server.toml"),
    devReleaseKeyFile: p.join(dataDir, "dev-release.key"),
    logsDir: p.join(dataDir, "logs"),
    tokensFile: p.join(dataDir, "tokens.json"),
    tokensLock: p.join(dataDir, "tokens.lock"),
    localTokenFile: p.join(dataDir, "local.token"),
    spoolDir: p.join(dataDir, "spool"),
    spoolDeadDir: p.join(dataDir, "spool", "dead"),
    spoolDrainLock: p.join(dataDir, "spool", ".drain.lock"),
    spoolRejectedLog: p.join(dataDir, "spool", "rejected.log"),
    cacheDir: p.join(dataDir, "cache"),
    hooksLog: p.join(dataDir, "logs", "hooks.log"),
    modelsDir: p.join(dataDir, "models"),
  };
}

/**
 * Files the coding tools own, which `mema init` edits (with a backup and a diff) and `mema doctor`
 * checks (clients.md §3, §6). They live under the user's home and are not moved by MA_HOME;
 * tests pass a temporary `home`.
 */
export interface ToolPaths {
  claudeSettingsFile: string;
  /** `CODEX_HOME` overrides `~/.codex` (Codex's own rule). */
  codexHome: string;
  codexConfigFile: string;
  /** Codex local plugin marketplace (ADR-0110). */
  agentsMarketplaceFile: string;
  /** The standalone skill read by Codex and Cursor (clients.md §3.3). */
  agentsSkillFile: string;
  cursorHooksFile: string;
  /** The Cursor plugin's install folder; the hook bundle must stay under ~/.cursor (ADR-0109). */
  cursorPluginDir: string;
}

export function resolveToolPaths({ platform, env, home }: PathInputs): ToolPaths {
  const p = platform === "win32" ? path.win32 : path.posix;
  const codexHome = env["CODEX_HOME"] && env["CODEX_HOME"].trim() !== "" ? p.resolve(env["CODEX_HOME"]) : p.join(home, ".codex");
  return {
    claudeSettingsFile: p.join(home, ".claude", "settings.json"),
    codexHome,
    codexConfigFile: p.join(codexHome, "config.toml"),
    agentsMarketplaceFile: p.join(home, ".agents", "plugins", "marketplace.json"),
    agentsSkillFile: p.join(home, ".agents", "skills", APP, "SKILL.md"),
    cursorHooksFile: p.join(home, ".cursor", "hooks.json"),
    cursorPluginDir: p.join(home, ".cursor", "plugins", "local", APP),
  };
}

function currentPlatform(): Platform {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`memory-anywhere does not support platform ${platform}`);
  }
  return platform;
}

/** Paths for the current process. */
export function currentPaths(): Paths {
  return resolvePaths({ platform: currentPlatform(), env: process.env, home: os.homedir() });
}

export function currentToolPaths(): ToolPaths {
  return resolveToolPaths({ platform: currentPlatform(), env: process.env, home: os.homedir() });
}
