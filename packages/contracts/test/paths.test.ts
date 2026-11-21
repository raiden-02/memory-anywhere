import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths", () => {
	it("keeps everything in one profile folder on Windows, outside AppData, spaces intact", () => {
		const p = resolvePaths({
			platform: "win32",
			env: { LOCALAPPDATA: "C:\\Users\\Ann Lee\\AppData\\Local", APPDATA: "C:\\Users\\Ann Lee\\AppData\\Roaming" },
			home: "C:\\Users\\Ann Lee",
		});
		expect(p.dataDir).toBe("C:\\Users\\Ann Lee\\.memory-anywhere");
		expect(p.configDir).toBe(p.dataDir);
		expect(p.clientConfigFile).toBe("C:\\Users\\Ann Lee\\.memory-anywhere\\client.toml");
		expect(p.tokensFile).toBe("C:\\Users\\Ann Lee\\.memory-anywhere\\tokens.json");
		expect(p.localServerDataDir).toBe("C:\\Users\\Ann Lee\\.memory-anywhere\\server");
		expect(JSON.stringify(p)).not.toMatch(/AppData|Documents/i);
	});

	it("puts data and config in one Application Support folder on macOS", () => {
		const p = resolvePaths({ platform: "darwin", env: {}, home: "/Users/ann" });
		expect(p.dataDir).toBe("/Users/ann/Library/Application Support/memory-anywhere");
		expect(p.configDir).toBe(p.dataDir);
	});

	it("follows XDG on Linux, with defaults", () => {
		expect(resolvePaths({ platform: "linux", env: {}, home: "/home/ann" })).toMatchObject({
			dataDir: "/home/ann/.local/share/memory-anywhere",
			configDir: "/home/ann/.config/memory-anywhere",
		});
		expect(
			resolvePaths({ platform: "linux", env: { XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" }, home: "/home/ann" }),
		).toMatchObject({ dataDir: "/d/memory-anywhere", configDir: "/c/memory-anywhere" });
	});

	it("lets MA_HOME replace both roots on every platform", () => {
		const win = resolvePaths({ platform: "win32", env: { MA_HOME: "D:\\ma home", LOCALAPPDATA: "X" }, home: "C:\\u" });
		expect(win.dataDir).toBe("D:\\ma home");
		expect(win.configDir).toBe("D:\\ma home");
		const linux = resolvePaths({ platform: "linux", env: { MA_HOME: "/tmp/ma home" }, home: "/home/ann" });
		expect(linux.clientConfigFile).toBe("/tmp/ma home/client.toml");
	});

	it("ignores empty environment values", () => {
		const p = resolvePaths({ platform: "linux", env: { MA_HOME: " ", XDG_DATA_HOME: "" }, home: "/home/ann" });
		expect(p.dataDir).toBe("/home/ann/.local/share/memory-anywhere");
	});
});
