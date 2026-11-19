// Reading inputs from disk: the user-level path guard (importers.md rule 2), the default locations
// of the file sources, ZIP exports, and the input hash that ties a commit to its dry run (rule 7).

import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { guardPath, loadInput, PathGuardError, userDirs, type UserDirs } from "../src/files.ts";
import { runImporter } from "../src/index.ts";
import { listEntries, readEntry, readZipTexts, ZipError } from "../src/zip.ts";
import { fixtureText, tempDir, zipOf } from "./helpers.ts";

let tmp: ReturnType<typeof tempDir>;
let dirs: UserDirs;

beforeEach(() => {
	tmp = tempDir();
	dirs = userDirs(path.join(tmp.dir, "home"), {});
	mkdirSync(dirs.home, { recursive: true });
});
afterEach(() => tmp.cleanup());

/** Installs the fixtures under their real names in the temporary home, as the coding tools keep them. */
function installHome(): void {
	tmp.write("home/.claude/CLAUDE.md", fixtureText("claude-user-md.md"));
	tmp.write("home/.claude/rules/coding.md", fixtureText("claude-user-md.rules-coding.md"));
	tmp.write("home/.codex/AGENTS.md", fixtureText("codex-user-md.md"));
	tmp.write("home/.codex/memories/notes.md", fixtureText("codex-memories.md"));
	tmp.write(
		"home/.claude/projects/C--Users-alex-orrery/memory/prefers-pnpm.md",
		fixtureText("claude-code-auto-memory.prefers-pnpm.md"),
	);
	tmp.write(
		"home/.claude/projects/C--Users-alex-orrery/memory/MEMORY.md",
		fixtureText("claude-code-auto-memory.MEMORY.md"),
	);
}

describe("path guard (rule 2)", () => {
	it("refuses any file inside a git repository, at any depth", () => {
		tmp.write("repo/.git/HEAD", "ref: refs/heads/main\n");
		const notes = tmp.write("repo/docs/deep/notes.txt", "- Alex likes tea\n");
		expect(() => guardPath(notes, dirs)).toThrow(PathGuardError);
		expect(() => loadInput("chatgpt-memory", notes, dirs)).toThrow(/inside a git repository/u);
		expect(() => loadInput("claude-user-md", path.join(tmp.dir, "repo", "docs", "deep"), dirs)).toThrow(
			/no input files|inside a git repository/u,
		);
	});

	it("S-POI-119: refuses a file in a git worktree or submodule, whose .git is a file, not a folder", () => {
		tmp.write("worktree/.git", "gitdir: ../repo/.git/worktrees/feature\n");
		const notes = tmp.write("worktree/docs/user-notes.md", "- Alex wants every memory exported\n");
		expect(() => guardPath(notes, dirs)).toThrow(/inside a git repository/u);
		expect(() => loadInput("claude-user-md", notes, dirs)).toThrow(/inside a git repository/u);
	});

	it("refuses a project's instruction files and tool folders outside ~/.claude and ~/.codex", () => {
		for (const rel of [
			"proj/CLAUDE.md",
			"proj/AGENTS.md",
			"proj/.cursor/rules/a.md",
			"proj/.claude/notes.md",
			"proj/.codex/AGENTS.md",
		]) {
			expect(() => guardPath(tmp.write(rel, "- x\n"), dirs), rel).toThrow(/project's coding-tool file/u);
		}
	});

	it("accepts the user-level files and ordinary exports", () => {
		installHome();
		expect(() => guardPath(path.join(dirs.claudeHome, "CLAUDE.md"), dirs)).not.toThrow();
		expect(() => guardPath(path.join(dirs.codexHome, "AGENTS.md"), dirs)).not.toThrow();
		expect(() => guardPath(tmp.write("Downloads/memories.txt", "x"), dirs)).not.toThrow();
	});

	it.skipIf(process.platform === "win32")("follows a symlink to where the file really is", () => {
		tmp.write("repo/.git/HEAD", "x");
		const target = tmp.write("repo/CLAUDE.md", "- x\n");
		const link = path.join(tmp.dir, "innocent.md");
		symlinkSync(target, link);
		expect(() => guardPath(link, dirs)).toThrow(/inside a git repository/u);
	});

	it("honours CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
		const d = userDirs(dirs.home, {
			CLAUDE_CONFIG_DIR: path.join(tmp.dir, "cc"),
			CODEX_HOME: path.join(tmp.dir, "cx"),
		});
		expect(d.claudeHome).toBe(path.join(tmp.dir, "cc"));
		expect(d.codexHome).toBe(path.join(tmp.dir, "cx"));
	});
});

describe("default locations", () => {
	it("reads each file source from its user-level folder, without a file argument", () => {
		installHome();
		expect(loadInput("claude-user-md", undefined, dirs).files.map((f) => f.name)).toEqual([
			"CLAUDE.md",
			"rules/coding.md",
		]);
		expect(loadInput("codex-user-md", undefined, dirs).files.map((f) => f.name)).toEqual(["AGENTS.md"]);
		expect(loadInput("codex-memories", undefined, dirs).files.map((f) => f.name)).toEqual(["memories/notes.md"]);
		const auto = loadInput("claude-code-auto-memory", undefined, dirs);
		expect(auto.files.map((f) => f.name)).toEqual([
			`${createHash("sha256").update("C--Users-alex-orrery").digest("hex").slice(0, 8)}/prefers-pnpm.md`,
		]);
		expect(auto.files[0]?.mtime).toBeInstanceOf(Date);
		const r = runImporter("claude-code-auto-memory", auto.files);
		expect(r.items.every((i) => i.group_id === auto.files[0]?.name && /^\d{4}-\d{2}-\d{2}$/u.test(i.date ?? ""))).toBe(
			true,
		);
	});

	it("says so when nothing is there, and needs a file for the other sources", () => {
		expect(() => loadInput("codex-memories", undefined, dirs)).toThrow(/no codex-memories files/u);
		expect(() => loadInput("chatgpt-memory", undefined, dirs)).toThrow(/needs a file or folder/u);
	});
});

describe("input hash (rule 7)", () => {
	it("is the file's SHA-256 for one file, and changes with its bytes", () => {
		const p = tmp.write("in/list.txt", "Alex likes tea.\n");
		expect(loadInput("chatgpt-memory", p, dirs).sha256).toBe(
			createHash("sha256").update("Alex likes tea.\n").digest("hex"),
		);
		tmp.write("in/list.txt", "Alex likes tea!\n");
		expect(loadInput("chatgpt-memory", p, dirs).sha256).not.toBe(
			createHash("sha256").update("Alex likes tea.\n").digest("hex"),
		);
	});

	it("covers every file of a folder", () => {
		installHome();
		const a = loadInput("claude-user-md", undefined, dirs).sha256;
		tmp.write("home/.claude/rules/more.md", "- Alex likes tea.\n");
		expect(loadInput("claude-user-md", undefined, dirs).sha256).not.toBe(a);
	});
});

describe("ZIP exports", () => {
	const conversations = fixtureText("claude-history.conversations.json");

	it("reads conversations.json from a deflated export, wherever it sits in the ZIP", () => {
		const zip = tmp.write(
			"Downloads/data-export.zip",
			zipOf([
				{ name: "users.json", data: "[]" },
				{ name: "export/conversations.json", data: conversations },
				{ name: "projects/", data: "", stored: true },
			]),
		);
		const input = loadInput("claude-history", zip, dirs);
		expect(input.files.map((f) => f.name)).toEqual(["data-export.zip/export/conversations.json"]);
		expect(runImporter("claude-history", input.files).items).toHaveLength(2);
		expect(input.sha256).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("reads only Gemini's MyActivity.json from a Takeout ZIP that holds other products' too", () => {
		const zip = tmp.write(
			"Downloads/takeout-20261115.zip",
			zipOf([
				{ name: "Takeout/archive_browser.html", data: "<html></html>" },
				{
					name: "Takeout/My Activity/Gemini Apps/MyActivity.json",
					data: fixtureText("gemini-history.MyActivity.json"),
				},
				{ name: "Takeout/My Activity/Search/MyActivity.json", data: '[{"header":"Search","title":"Searched for x"}]' },
			]),
		);
		const input = loadInput("gemini-history", zip, dirs);
		expect(input.files.map((f) => f.name)).toEqual([
			"takeout-20261115.zip/Takeout/My Activity/Gemini Apps/MyActivity.json",
		]);
		expect(runImporter("gemini-history", input.files).items).toHaveLength(2);
		const other = tmp.write(
			"Downloads/search-only.zip",
			zipOf([{ name: "Takeout/My Activity/Search/MyActivity.json", data: "[]" }]),
		);
		expect(() => loadInput("gemini-history", other, dirs)).toThrow(/holds no Gemini Apps MyActivity\.json/u);
	});

	it("reads stored entries and several numbered conversation files", () => {
		const zip = tmp.write(
			"x.zip",
			zipOf([
				{ name: "conversations-000.json", data: conversations, stored: true },
				{ name: "conversations-001.json", data: "[]" },
			]),
		);
		expect(readZipTexts(zip, /^conversations(?:[-_]\d+)?\.json$/iu).map((e) => e.name)).toEqual([
			"conversations-000.json",
			"conversations-001.json",
		]);
	});

	it("reads a folder of export ZIPs and conversations files, and refuses a ZIP without one", () => {
		tmp.write("exports/conversations-000.zip", zipOf([{ name: "conversations.json", data: conversations }]));
		tmp.write("exports/memories-000.zip", zipOf([{ name: "memories.json", data: "[]" }]));
		tmp.write("exports/notes.txt", "ignored");
		const input = loadInput("claude-history", path.join(tmp.dir, "exports"), dirs);
		expect(input.files.map((f) => f.name)).toEqual(["conversations-000.zip/conversations.json"]);
		expect(input.fileCount).toBe(2);
		expect(() => loadInput("claude-history", path.join(tmp.dir, "exports", "memories-000.zip"), dirs)).toThrow(
			/holds no conversations\.json/u,
		);
		expect(() => loadInput("chatgpt-memory", path.join(tmp.dir, "exports", "memories-000.zip"), dirs)).toThrow(
			/only for chat history/u,
		);
	});

	it("detects corruption and refuses what it cannot read", () => {
		const good = zipOf([{ name: "conversations.json", data: "[1,2,3]", stored: true }]);
		const bad = Buffer.from(good);
		bad[30 + "conversations.json".length] = "9".charCodeAt(0);
		const [entry] = listEntries(bad);
		expect(entry).toBeDefined();
		if (entry) expect(() => readEntry(bad, entry)).toThrow(/CRC-32/u);
		expect(() => listEntries(Buffer.from("not a zip at all, just text"))).toThrow(ZipError);
		const encrypted = Buffer.from(good);
		encrypted.writeUInt16LE(0x801, good.length - 22 - 46 - "conversations.json".length + 8);
		const [enc] = listEntries(encrypted);
		if (enc) expect(() => readEntry(encrypted, enc)).toThrow(/encrypted/u);
	});
});
