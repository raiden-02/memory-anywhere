import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/cdk.out/**", "**/dist/**", "evals/datasets/public/data/**", "docs/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The server's page script runs in the browser (auth-and-security.md §8).
    files: ["packages/server/src/web/assets/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly", document: "readonly", location: "readonly", history: "readonly", navigator: "readonly", fetch: "readonly",
        setTimeout: "readonly", PublicKeyCredential: "readonly",
      },
    },
  },
);
