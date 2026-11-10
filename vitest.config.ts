import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/cdk.out/**", "docs/**"],
  },
});
