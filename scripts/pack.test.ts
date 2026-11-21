import { describe, expect, it } from "vitest";
import { npmReadme } from "./pack.ts";

describe("the npm README", () => {
	it("points relative links into the repository on GitHub, and leaves absolute links and anchors alone", () => {
		const md = "[guide](docs/guide/02-local-mode.md) [risks](README.md#risks) [site](https://example.com) [top](#top)";
		expect(npmReadme(md)).toBe(
			"[guide](https://github.com/raiden-02/memory-anywhere/blob/main/docs/guide/02-local-mode.md) " +
				"[risks](https://github.com/raiden-02/memory-anywhere/blob/main/README.md#risks) " +
				"[site](https://example.com) [top](#top)",
		);
	});
});
