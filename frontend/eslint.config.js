import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "vite.config.d.ts", "vite.config.js", "*.tsbuildinfo", "src/vendor"],
  },
  {
    files: [
      "src/**/*.{ts,tsx}",
      "bridge/**/*.ts",
      "tests/**/*.ts",
      "e2e/**/*.ts",
      "playwright.config.ts",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // Best-effort cleanup blocks (`catch {}`) are used deliberately for
      // storage and JSON parsing; an empty catch is clearer than a comment.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["tests/**/*.ts", "e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The react-hooks v7 "recommended" preset also ships React Compiler
      // preview rules (set-state-in-effect, refs, …). This codebase uses the
      // documented latest-ref and reset-on-dep-change patterns those rules
      // flag, so we stick to the two long-standing rules above.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // The bridge is a behavior-preserving TypeScript port of a security-sensitive
    // classic script. Keep legacy catch bindings, short-circuit expressions, and
    // function-scoped timer declarations byte-equivalent after esbuild minification.
    files: ["bridge/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      "@typescript-eslint/no-unused-expressions": "off",
      "no-var": "off",
    },
  },
  {
    // shadcn-style primitive modules re-export Radix parts and cva variants
    // alongside components; that is their point, so the fast-refresh
    // boundary warning is just noise here. Same for the app entrypoint.
    files: ["src/components/ui/**/*.tsx", "src/main.tsx", "src/lib/theme.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
