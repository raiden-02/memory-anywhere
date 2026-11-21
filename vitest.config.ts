import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts", "**/*.test.mjs"],
		// Agent worktrees under .claude/ are not part of the suite.
		exclude: ["**/node_modules/**", "**/cdk.out/**", "docs/**", ".claude/**"],
	},
});
