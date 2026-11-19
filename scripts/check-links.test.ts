import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokenLinks, relativeLinks } from "./check-links.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("check-links", () => {
	it("finds relative links, and skips external ones, anchors, inline code and code blocks", () => {
		const text = [
			"[a](guide/01.md) [b](https://example.com) [c](#top) [d](mailto:x@example.com)",
			"`[e](not-a-link.md)` [f](../x.md#part)",
			"```",
			"[g](inside-a-block.md)",
			"```",
		].join("\n");
		expect(relativeLinks(text)).toEqual([
			{ line: 1, target: "guide/01.md" },
			{ line: 2, target: "../x.md#part" },
		]);
	});

	it("reports a link whose file is missing, relative to the linking file, in a folder with a space", () => {
		const root = mkdtempSync(path.join(tmpdir(), "ma links "));
		dirs.push(root);
		mkdirSync(path.join(root, "docs", "guide"), { recursive: true });
		writeFileSync(path.join(root, "docs", "guide", "01.md"), "[next](02.md) [up](../README.md#map)");
		writeFileSync(path.join(root, "docs", "README.md"), "[one](guide/01.md) [folder](guide/)");
		expect(brokenLinks(root, ["docs/guide/01.md", "docs/README.md"])).toEqual([
			{ file: "docs/guide/01.md", line: 1, target: "02.md" },
		]);
	});
});
