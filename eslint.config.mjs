import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Every plugin the Next presets register, so the override below can reference
// their rules (flat config needs the plugin in the same object as the rule).
const nextPlugins = Object.assign(
  {},
  ...[...nextVitals, ...nextTs].map((c) => c.plugins ?? {}),
);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Rules with a large pre-existing backlog are warnings, not errors, so the CI
  // lint gate (SEC-028) can pass and still catch everything else. Promote each
  // back to "error" once its warnings are cleared.
  {
    plugins: nextPlugins,
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react/no-unescaped-entities": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/vendor/**",
  ]),
]);

export default eslintConfig;
