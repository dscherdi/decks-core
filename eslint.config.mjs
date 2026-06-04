import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintCommentsPlugin from "@eslint-community/eslint-plugin-eslint-comments";
import globals from "globals";

// Mirrors the obsidian-plugin's TypeScript lint rules, minus the Svelte and
// Obsidian-specific pieces (core is platform-agnostic and ships no UI).
export default [
  js.configs.recommended,

  {
    ignores: [
      "dist/",
      "node_modules/",
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "*.config.cjs",
      "*.config.mjs",
    ],
  },

  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        ...globals.es2020,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "@eslint-community/eslint-comments": eslintCommentsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "prefer-const": "error",
      // Promise/async rules (type-aware)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "warn",
      // Template literal rules
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: true,
          allowRegExp: false,
        },
      ],
      // Prevent disabling no-explicit-any via inline comments
      "@eslint-community/eslint-comments/no-use": [
        "error",
        {
          allow: [
            "eslint-disable-next-line",
            "eslint-disable",
            "eslint-enable",
            "global",
          ],
        },
      ],
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        "@typescript-eslint/no-explicit-any",
      ],
      // Every eslint-disable directive must explain why (matches the Obsidian
      // plugin validator's stricter check).
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: [] },
      ],
    },
  },
];
