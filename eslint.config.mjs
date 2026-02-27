import globals from "globals";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "semi": ["error", "never"],
      "quotes": ["warn", "double"],
      "no-var": "error",
      "prefer-const": "warn"
    },
    ignores: ["node_modules/", "data/"]
  }
];
