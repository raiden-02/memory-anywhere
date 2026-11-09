// M0 Q07, Q12 (Claude Code part), Q13 (Claude Code part), Q17 (settings keys) on the owner's PC,
// headless, without touching the owner's Claude Code configuration: every plugin is loaded with
// --plugin-dir from a temporary folder whose path contains spaces, extra settings with --settings.
//
//   node spikes/plugins/claude-code.ts [--model claude-haiku-5-5] [--out evidence.json]
//
// Writes hook fixtures to evals/fixtures/hooks/claude-code/<version>/ (home folder replaced).

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..", "..");
const STUB = join(ROOT, "spikes", "stub-server", "src", "main.ts");
const RECORDER = join(ROOT, "spikes", "hook-recorder", "record.mjs");
const CANARY = "HOOK-CANARY-5RJ8";
const TOOL_PREFIX = "mcp__plugin_memory-anywhere_memory-anywhere__";

interface PluginOptions {
  alwaysLoad?: boolean;
  denySettings?: boolean;
}

interface Session {
  init: { tools?: string[]; mcp_servers?: { name: string; status: string; source?: string }[] } | undefined;
  result: { result?: string; permission_denials?: unknown[]; is_error?: boolean } | undefined;
  toolUses: string[];
  toolErrors: string[];
}

function writePlugin(dir: string, opts: PluginOptions): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  cpSync(RECORDER, join(dir, "record.mjs"));
  const rec = join(dir, "record.mjs");
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "memory-anywhere", version: "0.0.1-m0", description: "M0 spike" }));
  const server: Record<string, unknown> = { command: "node", args: [STUB, "stdio"] };
  if (opts.alwaysLoad) server["alwaysLoad"] = true;
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "memory-anywhere": server } }));
  const hook = (event: string) => [{ type: "command", command: "node", args: [rec, "claude-code", event], timeout: 5 }];
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: hook("session-start") }], UserPromptSubmit: [{ hooks: hook("prompt") }] } }),
  );
  if (opts.denySettings) writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(echo q13-denied*)"] } }));
}

/** The prompt goes right after -p: list-valued flags such as --allowedTools would swallow a later positional. */
function runClaude(prompt: string, args: string[], cwd: string, env: Record<string, string>): Session {
  const r = spawnSync("claude", ["-p", prompt, ...args, "--output-format", "stream-json", "--verbose", "--no-session-persistence"], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 2 ** 20,
    timeout: 300_000,
  });
  const events = (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const toolUses: string[] = [];
  const toolErrors: string[] = [];
  for (const e of events) {
    const content = ((e["message"] as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
    for (const c of content) {
      if (c["type"] === "tool_use") toolUses.push(String(c["name"]));
      if (c["type"] === "tool_result" && c["is_error"]) toolErrors.push(JSON.stringify(c["content"]).slice(0, 200));
    }
  }
  return {
    init: events.find((e) => e["type"] === "system" && e["subtype"] === "init") as Session["init"],
    result: events.find((e) => e["type"] === "result") as Session["result"],
    toolUses,
    toolErrors,
  };
}

function recordings(maHome: string, event: string): Record<string, unknown>[] {
  const dir = join(maHome, "spike", "hooks", "claude-code", event);
  try {
    return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Replace the owner's home folder in paths, so fixtures carry no username: both the path form
 * and the dashed form Claude Code uses for project folder names (C--Users-<name>-...). */
export function anonymise(v: unknown, home = homedir()): unknown {
  const dashed = home.replace(/[:\\/]/g, "-");
  const json = JSON.stringify(v).split(JSON.stringify(home).slice(1, -1)).join("<home>").split(dashed).join("<home-slug>");
  return JSON.parse(json);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { model: { type: "string", default: "claude-haiku-5-5" }, out: { type: "string" } } });
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(" ")[0] ?? "unknown";
  const base = mkdtempSync(join(tmpdir(), "ma cc spike "));
  const report: Record<string, unknown> = { claude_code_version: version, model: values.model, platform: `${process.platform}-${process.arch}` };
  const model = ["--model", values.model];
  try {
    const work = join(base, "work dir");
    mkdirSync(work);

    // A. Q12 hooks: 3 sessions, exec-form hooks from a plugin under a path with spaces.
    const pA = join(base, "plugin A");
    writePlugin(pA, { alwaysLoad: true });
    const maA = join(base, "ma home A");
    const canaryRuns: { answer: string; ok: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      const s = runClaude("What is the session canary? Reply with only the canary.", [...model, "--plugin-dir", pA], work, { MA_HOME: maA, MA_STUB_DATA: join(base, "stub") });
      const answer = s.result?.result?.trim() ?? "";
      canaryRuns.push({ answer, ok: answer.includes(CANARY) });
    }
    const starts = recordings(maA, "session-start");
    const prompts = recordings(maA, "prompt");
    report["q12_hooks"] = {
      sessions: 3,
      session_start_calls: starts.length,
      prompt_calls: prompts.length,
      session_start_payload_keys: [...new Set(starts.flatMap((r) => Object.keys(r["payload"] as object)))].sort(),
      prompt_payload_keys: [...new Set(prompts.flatMap((r) => Object.keys(r["payload"] as object)))].sort(),
      session_start_sources: starts.map((r) => (r["payload"] as { source?: string }).source),
      context_reached_model: canaryRuns,
      hook_env_variable_names: (starts[0]?.["env"] as string[] | undefined) ?? [],
    };
    const fixtures = join(ROOT, "evals", "fixtures", "hooks", "claude-code", version);
    mkdirSync(fixtures, { recursive: true });
    if (starts[0]) writeFileSync(join(fixtures, "session-start.json"), JSON.stringify(anonymise(starts[0]["payload"]), null, 2) + "\n");
    if (prompts[0]) writeFileSync(join(fixtures, "prompt.json"), JSON.stringify(anonymise(prompts[0]["payload"]), null, 2) + "\n");

    // B. Q07 deferral: does Claude Code defer the tools (ToolSearch first) and do the flags keep them loaded?
    const q07: Record<string, unknown>[] = [];
    for (const [name, opts, env] of [
      ["no flag", { alwaysLoad: false }, {}],
      [".mcp.json alwaysLoad", { alwaysLoad: true }, {}],
      ['tool _meta["anthropic/alwaysLoad"]', { alwaysLoad: false }, { MA_STUB_ALWAYS_LOAD_META: "1" }],
    ] as [string, PluginOptions, Record<string, string>][]) {
      for (const toolSearch of ["true", "auto"]) {
        const dir = join(base, `plugin q07 ${q07.length}`);
        writePlugin(dir, opts);
        const s = runClaude(
          "Call the memory_status tool exactly once and reply with the value of its store field only.",
          [...model, "--plugin-dir", dir, "--allowedTools", `${TOOL_PREFIX}memory_status`],
          work,
          { ...env, ENABLE_TOOL_SEARCH: toolSearch, MA_HOME: join(base, "ma home q07"), MA_STUB_DATA: join(base, "stub") },
        );
        const statusAt = s.toolUses.indexOf(`${TOOL_PREFIX}memory_status`);
        const searchedFirst = s.toolUses.slice(0, statusAt < 0 ? undefined : statusAt).some((t) => /ToolSearch/i.test(t));
        q07.push({ variant: name, ENABLE_TOOL_SEARCH: toolSearch, tool_uses: s.toolUses, deferred: searchedFirst, answer: s.result?.result?.trim() });
      }
    }
    report["q07_deferral"] = q07;

    // C. Q13 (Claude Code): does a plugin's settings.json permissions.deny apply?
    const q13: Record<string, unknown>[] = [];
    for (const deny of [true, false]) {
      const dir = join(base, `plugin q13 ${deny ? "deny" : "control"}`);
      writePlugin(dir, { alwaysLoad: true, denySettings: deny });
      const s = runClaude("Run this exact shell command with the Bash tool and report its output: echo q13-denied-marker", [...model, "--plugin-dir", dir, "--allowedTools", "Bash"], work, {
        MA_HOME: join(base, "ma home q13"),
        MA_STUB_DATA: join(base, "stub"),
      });
      q13.push({ plugin_settings_deny: deny, tool_uses: s.toolUses, permission_denials: s.result?.permission_denials ?? [], tool_errors: s.toolErrors, answer: s.result?.result?.trim() });
    }
    report["q13_plugin_settings_deny"] = q13;

    // D. Headless flags (Q12): which MCP servers load under --strict-mcp-config and --setting-sources.
    const flags: Record<string, unknown>[] = [];
    for (const extra of [[], ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], ["--setting-sources", "user"], ["--setting-sources", ""]]) {
      const s = runClaude("Reply with the word ok.", [...model, "--plugin-dir", pA, ...extra], work, { MA_HOME: join(base, "ma home flags"), MA_STUB_DATA: join(base, "stub") });
      flags.push({ flags: extra.join(" ") || "(none)", mcp_servers: (s.init?.mcp_servers ?? []).map((m) => `${m.source ?? "?"}:${m.name}:${m.status}`) });
    }
    report["q12_headless_flags"] = flags;

    // E. Q17: does disabledMcpjsonServers (settings) disable a project .mcp.json server of that name?
    const proj = join(base, "project dir");
    mkdirSync(proj);
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { "memory-anywhere": { command: "node", args: [STUB, "stdio"] } } }));
    const q17: Record<string, unknown>[] = [];
    for (const settings of [null, { disabledMcpjsonServers: ["memory-anywhere"] }]) {
      const s = runClaude("Reply with the word ok.", [...model, ...(settings ? ["--settings", JSON.stringify(settings)] : [])], proj, { MA_STUB_DATA: join(base, "stub") });
      q17.push({
        settings: settings ?? "(none)",
        project_server: (s.init?.mcp_servers ?? []).filter((m) => m.source !== "user" && m.source !== "claudeai" && /memory-anywhere/.test(m.name)),
        claude_ai_connectors: (s.init?.mcp_servers ?? []).filter((m) => m.source === "claudeai").map((m) => m.name),
      });
    }
    report["q17_disabledMcpjsonServers"] = q17;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const text = JSON.stringify(anonymise(report), null, 2);
  console.log(text);
  if (values.out) writeFileSync(values.out, text + "\n");
}

if (import.meta.main) await main();
