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
  };
}

/** Paths for the current process. */
export function currentPaths(): Paths {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`memory-anywhere does not support platform ${platform}`);
  }
  return resolvePaths({ platform, env: process.env, home: os.homedir() });
}
