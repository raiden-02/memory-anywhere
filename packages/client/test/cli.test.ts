import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, main } from "../src/cli.ts";
import { CLIENT_VERSION } from "../src/config.ts";

/** Runs `mema …` and returns its exit code and what it printed. */
async function mema(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
	const code = await main(argv);
	return { code, out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => vi.restoreAllMocks());

describe("mema's help", () => {
	it("bare `mema` says what it is, lists the commands by group and where to start", async () => {
		const r = await mema();
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(/^mema: one personal memory for all your AI apps/u);
		for (const group of ["Set up", "Every day", "Your memories", "Your own server", "Coding tools"])
			expect(r.out).toContain(group);
		expect(r.out).toContain("Start with `mema init`");
	});

	it("keeps the coding tools' plumbing and the drill-only deploy flags out of the help", async () => {
		const overview = (await mema("--help")).out;
		expect(overview).not.toMatch(/^\s+(mcp|hook)\b/mu);
		const deploy = (await mema("deploy", "--help")).out;
		expect(deploy).toContain("--stage prod");
		expect(deploy).not.toMatch(/replace-instance|release-file|allow-replace/u);
	});

	it("shows one command's usage and options", async () => {
		const r = await mema("search", "--help");
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(/^usage: mema search <query> \[options\]/u);
		expect(r.out).toMatch(/--limit <1\.\.10>\s+how many results/u);
		expect((await mema("help", "search")).out).toBe(r.out);
	});

	it("prints its own version without asking the store", async () => {
		expect(await mema("--version")).toMatchObject({ code: EXIT.ok, out: CLIENT_VERSION });
	});
});

describe("mema's answers to mistakes", () => {
	it("names an unknown command and lists the real ones", async () => {
		const r = await mema("stauts");
		expect(r.code).toBe(EXIT.usage);
		expect(r.err).toMatch(/there is no command `stauts`/u);
		expect(r.err).toContain("Set up");
	});

	it("answers an unknown flag with that command's help, not a stack trace", async () => {
		const r = await mema("status", "--foo");
		expect(r.code).toBe(EXIT.usage);
		expect(r.err).toMatch(/^mema status: Unknown option '--foo'/u);
		expect(r.err).toContain("usage: mema status");
		expect(r.err).not.toMatch(/\n\s+at /u);
	});

	it("refuses a flag that belongs to another command", async () => {
		const r = await mema("status", "--commit");
		expect(r.code).toBe(EXIT.usage);
		expect(r.err).toMatch(/Unknown option '--commit'/u);
	});

	it("says what a command needs before doing anything", async () => {
		expect((await mema("search")).err).toMatch(/^mema search: search needs a query/u);
		expect((await mema("export")).err).toMatch(/^mema export: export needs --out <file>/u);
		expect((await mema("deploy", "aws")).err).toMatch(/^mema deploy: --stage is required/u);
	});
});
