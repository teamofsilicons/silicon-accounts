import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-*/**", "out/**", "build/**", "next-env.d.ts", "public/**", "test-results/**"]),
  {
    // The public pages (the home page and the docs) are plain HTML documents: their links are plain <a> elements on
    // purpose, so a visit loads no client router state and nothing is prefetched (see components/site/site-header.tsx).
    files: ["components/site/**", "components/home/**", "components/docs/**", "app/(public)/**", "app/not-found.tsx", "app/error.tsx"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
]);
