// The plugin folders (clients.md §3): versions match the client, every command calls the bundled
// client by path with `node` (never npx or a shell shim), and the texts are the policy's.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIENT_TEXTS } from "@memory-anywhere/contracts/policy-data";
import { expect, it } from "vitest";
import { CLIENT_VERSION } from "../src/config.ts";

const PLUGINS = path.join(import.meta.dirname, "..", "..", "..", "plugins");
const json = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(PLUGINS, rel), "utf8")) as Record<string, unknown>;

it("carries the client's version in every plugin manifest", () => {
  expect(json("claude-code/.claude-plugin/plugin.json")["version"]).toBe(CLIENT_VERSION);
  expect(json("cursor/.cursor-plugin/plugin.json")["version"]).toBe(CLIENT_VERSION);
});

it("runs the bundled client with node, in exec form, for the server and both hooks", () => {
  const mcp = json("claude-code/.mcp.json") as { mcpServers: Record<string, { command: string; args: string[]; alwaysLoad: boolean }> };
  expect(mcp.mcpServers["memory-anywhere"]).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/memory-anywhere.mjs", "mcp", "--tool", "claude-code"], alwaysLoad: true });
  const hooks = JSON.stringify(json("claude-code/hooks/hooks.json"));
  expect(hooks).toContain('"args":["${CLAUDE_PLUGIN_ROOT}/dist/memory-anywhere.mjs","hook","claude-code","session-start"]');
  expect(hooks).toContain('"async":true');
  expect(hooks).not.toMatch(/npx|\.cmd|\.ps1/u);
});

it("ships the policy's skill and Cursor rule texts", () => {
  expect(readFileSync(path.join(PLUGINS, "claude-code/skills/memory-anywhere/SKILL.md"), "utf8")).toBe(`${CLIENT_TEXTS.skill}\n`);
  expect(readFileSync(path.join(PLUGINS, "cursor/rules/memory-anywhere.mdc"), "utf8")).toMatch(/^---\ndescription: memory-anywhere personal memory \(policy P1\)\nalwaysApply: true\n---\n/u);
});
