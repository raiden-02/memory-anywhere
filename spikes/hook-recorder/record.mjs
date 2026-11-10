#!/usr/bin/env node
// M0 hook recorder (m0-spike.md §1, Q12): `node record.mjs <tool> <event>`.
// Writes the hook's stdin JSON, with the argv and selected environment it was called with, to
// {data}/spike/hooks/<tool>/<event>/<iso>.json (data = %LOCALAPPDATA%\memory-anywhere on Windows,
// or MA_HOME). Prints nothing, except on session-start, where it prints a canary context in the
// shape the tool documents, so a test can check the context reached the model. Never fails.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers";

const [tool = "unknown", event = "unknown"] = process.argv.slice(2);
export const CANARY = "HOOK-CANARY-5RJ8";

function dataDir() {
  if (process.env.MA_HOME) return process.env.MA_HOME;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "memory-anywhere");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "memory-anywhere");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "memory-anywhere");
}

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    setTimeout(() => resolve(s), 3000); // a tool that never closes stdin must not hang the hook
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { unparsed_stdin: raw };
}
// Only the NAMES of the tool's environment variables: values can hold the owner's domain
// (MA_DOMAIN), email (CLAUDE_CODE_USER_EMAIL) or tokens, and fixtures are committed.
const keepEnv = Object.keys(process.env)
  .filter((k) => /^(CLAUDE_|CODEX_|CURSOR_)/.test(k))
  .sort();
try {
  const dir = join(dataDir(), "spike", "hooks", tool, event);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}-${process.pid}.json`), JSON.stringify({ tool, event, argv: process.argv.slice(1), cwd: process.cwd(), env: keepEnv, payload }, null, 2));
} catch {
  // recording is best effort; the hook must never fail the session
}

// A plugin copy is recorded as <tool>-plugin; it answers in the same shape as its tool.
const family = tool.replace(/-plugin$/, "");
if (/^session-?start$/i.test(event)) {
  const context = `memory-anywhere hook canary: if asked for the session canary, reply exactly ${CANARY}.`;
  if (family === "claude-code" || family === "codex") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  } else if (family === "cursor") {
    process.stdout.write(JSON.stringify({ additional_context: context }));
  } else {
    process.stdout.write(context);
  }
} else if (family === "cursor" && event === "beforeSubmitPrompt") {
  process.stdout.write(JSON.stringify({ continue: true }));
}
process.exitCode = 0;
