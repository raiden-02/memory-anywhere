// The client bundle (config-and-cli.md §2): one pure-JS file that runs with plain `node`, with no
// native modules, copied into each plugin's dist/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { BUNDLE, buildClient, PLUGIN_BUNDLES } from "../../../scripts/build.ts";
import { CLIENT_VERSION } from "../src/config.ts";

beforeAll(async () => {
  await buildClient();
}, 60_000);

it("runs `version` from the bundle and carries no native module", () => {
  const r = spawnSync(process.execPath, [BUNDLE, "version"], { encoding: "utf8", env: { ...process.env, MA_STORE_URL: "http://127.0.0.1:9" } });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`client ${CLIENT_VERSION}, policy P1`);
  expect(readFileSync(BUNDLE, "utf8")).not.toMatch(/\.node["']\)/u);
  for (const p of PLUGIN_BUNDLES) expect(existsSync(p)).toBe(true);
});

it("answers a hook with nothing and exit 0 when stdin is empty", () => {
  const r = spawnSync(process.execPath, [BUNDLE, "hook", "claude-code", "session-start"], { input: "", encoding: "utf8", env: { ...process.env, MA_STORE_URL: "http://127.0.0.1:9" } });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
});
