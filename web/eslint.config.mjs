import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-*/**", "out/**", "build/**", "next-env.d.ts", "public/**", ".screens/**", "e2e/.artifacts/**", "components/*/checks.ts", "lib/agent/generated/**"]),
  {
    // The public landing page is a plain HTML document with no client router (no providers, no account shell): its
    // links are plain <a> elements on purpose, so leaving it is a full page load (see components/site/site-header.tsx).
    files: ["components/site/**", "components/landing/**"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
]);
