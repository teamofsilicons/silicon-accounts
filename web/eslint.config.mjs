import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import siliconUi from "@teamofsilicons/silicon-ui/eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-*/**", "out/**", "build/**", "next-env.d.ts", "public/**", ".screens/**", "e2e/.artifacts/**", "components/*/checks.ts", "lib/agent/generated/**",
    // Vendored: the stageshow kit (components/foundation/stageshow/README.md), linted by its own project.
    "components/foundation/stageshow/kit/**"]),
  {
    // The public landing page is a plain HTML document with no client router (no providers, no account shell): its
    // links are plain <a> elements on purpose, so leaving it is a full page load (see components/site/site-header.tsx).
    files: ["components/site/**", "components/landing/**"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  // Silicon UI's guardrails: no re-created components, no borrowed component CSS, no local component copies.
  // Older violations are recorded in eslint-suppressions.json; it may only shrink (docs/guardrails.md in silicon-ui).
  // nav-list: the account sidebar (redesign/decisions.md, 2026-10-29). button: the search trigger's soft variant
  // (borderless grey, the bar control), still experimental in Silicon UI 0.4. button-link: the same soft variant for the
  // sidebar's Developers and Docs chips (2026-10-30). segmented-control: the xs size, in the development-only dev states
  // panel (components/foundation/dev, 2026-10-31).
  // dropdown-menu: its parts, for Add a Silicon's menu on /silicons to carry the Silicon UI scope (an experiment, 2026-11-07).
  ...siliconUi({ allowExperimental: ["nav-list", "button", "button-link", "segmented-control", "dropdown-menu"] }),
  {
    // The landing frames are not the account shell. How it works steps are text rows from the frame, not Silicon UI buttons.
    files: ["components/landing/**"],
    rules: { "no-restricted-syntax": "off" },
  },
]);
