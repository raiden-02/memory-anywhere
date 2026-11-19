import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts", "**/*.test.mjs"],
		// .claude/worktrees holds other sessions' checkouts of this repository.
		exclude: ["**/node_modules/**", "**/cdk.out/**", "docs/**", ".claude/**"],
	},
});
