// Reading an import's input from disk: the path guard (rule 2), the default user-level locations
// of the file sources, folders, ZIP exports, and the input's SHA-256 (rule 7 ties a commit to the
// dry run of the same input).
//
//   mema import <file|folder> --source s      mema import --source claude-user-md
//            │                                          │ ~/.claude/CLAUDE.md, ~/.claude/rules/*.md
//            ▼                                          ▼
//   candidate files ──guard──► read (a .zip: its conversations*.json) ──► SourceFile[] + sha256

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./common.ts";
import type { SourceFile, SourceType } from "./types.ts";
import { readZipTexts } from "./zip.ts";

/** Where the coding tools keep their user-level files. Tests pass a temporary home. */
export interface UserDirs {
	readonly home: string;
	/** `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
	readonly claudeHome: string;
	/** `CODEX_HOME`, else `~/.codex`. */
	readonly codexHome: string;
}

export function userDirs(home: string, env: Readonly<Record<string, string | undefined>>): UserDirs {
	const claude = env["CLAUDE_CONFIG_DIR"]?.trim();
	const codex = env["CODEX_HOME"]?.trim();
	return {
		home,
		claudeHome: claude ? path.resolve(claude) : path.join(home, ".claude"),
		codexHome: codex ? path.resolve(codex) : path.join(home, ".codex"),
	};
}

/** Sources read from the coding tools' own folders; they may run without a file argument. */
export const FILE_SOURCES = [
	"claude-user-md",
	"codex-user-md",
	"claude-code-auto-memory",
	"codex-memories",
] as const satisfies readonly SourceType[];
export const HISTORY_SOURCES = [
	"chatgpt-history",
	"claude-history",
	"gemini-history",
] as const satisfies readonly SourceType[];

const isFileSource = (s: SourceType): boolean => (FILE_SOURCES as readonly SourceType[]).includes(s);
const isHistorySource = (s: SourceType): boolean => (HISTORY_SOURCES as readonly SourceType[]).includes(s);

// ---- rule 2: the path guard

export class PathGuardError extends Error {
	override readonly name = "PathGuardError";
}

function real(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
}

const caseless = process.platform === "win32" || process.platform === "darwin";

function within(file: string, root: string): boolean {
	const rel = path.relative(caseless ? root.toLowerCase() : root, caseless ? file.toLowerCase() : file);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The nearest folder at or above `dir` that holds `.git` (a repository root), if any. */
export function repoRootOf(dir: string): string | undefined {
	for (let d = path.resolve(dir); ; d = path.dirname(d)) {
		if (existsSync(path.join(d, ".git"))) return d;
		if (path.dirname(d) === d) return undefined;
	}
}

const PROJECT_FILES = new Set(["claude.md", "claude.local.md", "agents.md", "agents.override.md"]);
const TOOL_DIRS = new Set([".claude", ".codex", ".cursor", ".agents"]);

/**
 * Refuses a file that a repository could have written (importers.md rule 2): anything inside a git
 * repository, and any coding-tool instruction file or tool folder that is not the owner's
 * user-level one (`~/.claude`, `~/.codex`). Symlinks are resolved first.
 */
export function guardPath(file: string, dirs: UserDirs): void {
	const target = real(file);
	const root = repoRootOf(path.dirname(target));
	if (root)
		throw new PathGuardError(
			`refusing ${file}: it is inside a git repository (${root}); importers read user-level files only`,
		);
	const allowed = [real(dirs.claudeHome), real(dirs.codexHome)].some((r) => within(target, r));
	if (allowed) return;
	const segments = path
		.relative(path.parse(target).root, target)
		.split(path.sep)
		.map((s) => s.toLowerCase());
	const base = segments.at(-1) ?? "";
	if (PROJECT_FILES.has(base) || segments.slice(0, -1).some((s) => TOOL_DIRS.has(s))) {
		throw new PathGuardError(
			`refusing ${file}: a project's coding-tool file; importers read only ~/.claude and ~/.codex`,
		);
	}
}

// ---- default locations

function listDir(dir: string, keep: (name: string) => boolean): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile() && keep(e.name))
			.map((e) => path.join(dir, e.name))
			.sort();
	} catch {
		return [];
	}
}

const md = (n: string): boolean => n.toLowerCase().endsWith(".md");

/** An input file and its label (relative, never the absolute path: labels leave the PC as group ids). */
export interface Candidate {
	readonly file: string;
	readonly label: string;
}

/** Claude Code's project folders are named after the full project path; the label keeps only a short hash of it. */
const projectLabel = (slug: string, file: string): string => `${sha256Hex(slug).slice(0, 8)}/${path.basename(file)}`;

/** The user-level files of a file source (importers.md §2), whichever exist. */
export function defaultCandidates(source: SourceType, dirs: UserDirs): Candidate[] {
	const rel =
		(root: string) =>
		(file: string): Candidate => ({ file, label: path.relative(root, file).split(path.sep).join("/") });
	switch (source) {
		case "claude-user-md":
			return [path.join(dirs.claudeHome, "CLAUDE.md"), ...listDir(path.join(dirs.claudeHome, "rules"), md)]
				.filter((f) => existsSync(f))
				.map(rel(dirs.claudeHome));
		case "codex-user-md":
			return [path.join(dirs.codexHome, "AGENTS.md")].filter((f) => existsSync(f)).map(rel(dirs.codexHome));
		case "codex-memories":
			return listDir(path.join(dirs.codexHome, "memories"), md).map(rel(dirs.codexHome));
		case "claude-code-auto-memory": {
			const projects = path.join(dirs.claudeHome, "projects");
			let slugs: string[];
			try {
				slugs = readdirSync(projects, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name)
					.sort();
			} catch {
				slugs = [];
			}
			return slugs.flatMap((slug) =>
				listDir(path.join(projects, slug, "memory"), (n) => md(n) && n !== "MEMORY.md").map((file) => ({
					file,
					label: projectLabel(slug, file),
				})),
			);
		}
		default:
			throw new Error(`--source ${source} needs a file or folder to read`);
	}
}

/** The files to read from a file or folder the owner named. */
export function targetCandidates(source: SourceType, target: string): Candidate[] {
	const st = statSync(target);
	if (!st.isDirectory()) return [{ file: target, label: path.basename(target) }];
	const pick = isHistorySource(source)
		? (n: string): boolean => /\.zip$/iu.test(n) || historyJson(source).test(n)
		: isFileSource(source)
			? (n: string): boolean => md(n) && !(source === "claude-code-auto-memory" && n === "MEMORY.md")
			: (n: string): boolean => /\.(?:txt|md)$/iu.test(n);
	return listDir(target, pick).map((file) => ({ file, label: path.basename(file) }));
}

// ---- reading

export interface LoadedInput {
	readonly files: readonly SourceFile[];
	/** SHA-256 of the input: the file's bytes, or for several files, of their labels and hashes. */
	readonly sha256: string;
	/** How many files on disk were read (a ZIP counts once). */
	readonly fileCount: number;
}

/** Text saved by Notepad and some browsers starts with a byte-order mark; it is not content. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The history file of each export: ChatGPT's and Claude's conversations JSON, Google Takeout's MyActivity.json. */
const historyJson = (source: SourceType): RegExp =>
	source === "gemini-history" ? /^MyActivity\.json$/iu : /^conversations(?:[-_]\d+)?\.json$/iu;

/** Reads and guards every candidate; a ZIP gives its history JSON files. */
export function loadInput(source: SourceType, target: string | undefined, dirs: UserDirs): LoadedInput {
	const candidates = target === undefined ? defaultCandidates(source, dirs) : targetCandidates(source, target);
	if (candidates.length === 0)
		throw new Error(
			target === undefined
				? `no ${source} files found in their default location`
				: `no input files for ${source} in ${target}`,
		);
	const files: SourceFile[] = [];
	const hashes: string[] = [];
	for (const c of candidates) {
		guardPath(c.file, dirs);
		const bytes = readFileSync(c.file);
		const sha = sha256Hex(bytes);
		hashes.push(`${c.label}\u0000${sha}`);
		const mtime = statSync(c.file).mtime;
		if (/\.zip$/iu.test(c.file)) {
			if (!isHistorySource(source)) throw new Error(`${c.label}: a ZIP is read only for chat history sources`);
			// A Takeout ZIP can hold other products' MyActivity.json too; only Gemini's folder is read.
			const inner = readZipTexts(bytes, historyJson(source)).filter(
				(e) => source !== "gemini-history" || /(^|\/)Gemini[^/]*\/MyActivity\.json$/iu.test(e.name),
			);
			if (inner.length === 0 && target !== undefined && candidates.length === 1)
				throw new Error(
					`${c.label} holds no ${source === "gemini-history" ? "Gemini Apps MyActivity.json" : "conversations.json"}`,
				);
			for (const e of inner) files.push({ name: `${c.label}/${e.name}`, text: e.text, mtime });
			continue;
		}
		files.push({ name: c.label, text: stripBom(bytes.toString("utf8")), mtime });
	}
	const sha256 =
		candidates.length === 1 ? ((hashes[0] ?? "").split("\u0000")[1] ?? "") : sha256Hex(hashes.sort().join("\n"));
	return { files, sha256, fileCount: candidates.length };
}
