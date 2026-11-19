import { describe, expect, it } from "vitest";
import { openBrowser } from "../src/cli.ts";

describe("opening the browser", () => {
	it("never opens one under MA_NO_BROWSER, so the caller prints the link (config-and-cli.md §7)", async () => {
		expect(await openBrowser("https://memory.example.com/approve/stp_x", { MA_NO_BROWSER: "1" })).toBe(false);
	});

	it("refuses anything but an http(s) link", async () => {
		expect(await openBrowser("file:///C:/Windows/notepad.exe", {})).toBe(false);
	});
});
