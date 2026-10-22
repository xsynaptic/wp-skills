import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import eslint from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import path from "node:path";
import tseslint from "typescript-eslint";

// ESLint doesn't read .gitignore on its own, and vendor/ is Composer's
const gitignored = includeIgnoreFile(
  path.join(import.meta.dirname, ".gitignore"),
);

export default defineConfig(
  gitignored,
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  unicorn.configs.recommended,
  perfectionist.configs["recommended-natural"],
  {
    languageOptions: { parserOptions: { projectService: true } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
      // `node:test` registers and awaits its own `describe` and `test` promises
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              name: ["describe", "test"],
              package: "node:test",
            },
          ],
        },
      ],
      // WP-CLI and the wordpress.org API send an empty string for absent, so `||` on a string is meant
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      // Its fixer moves declarations blind to what depends on their order
      "perfectionist/sort-modules": "off",
      // JSON and WP-CLI output speak `null` for absent
      "unicorn/no-null": "off",
      // Rewrites a flat guard-clause ladder into a ternary chain
      "unicorn/prefer-ternary": "off",
    },
  },
  {
    // A CLI ends with an exit status; `process.exitCode` alone can leave it waiting on an SSH control socket
    files: [
      "skills/wordpress-ops/scripts/{live-check,scan,smoke,snapshot}.ts",
      "skills/wordpress-ops/templates/local-stack/rebuild.ts",
    ],
    rules: { "unicorn/no-process-exit": "off" },
  },
);
