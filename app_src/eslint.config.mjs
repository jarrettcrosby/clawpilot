import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // Private operator bundles are compiled output; lint their TypeScript source.
    "dist/**",
    // Playwright output and one-off local validation artifacts are not app source.
    "test-results/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
