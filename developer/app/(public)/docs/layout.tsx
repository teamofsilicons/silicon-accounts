/**
 * /docs: the Silicon Developer docs, rendered from the repository's docs/ and docs-apps/ (bundled at build time by
 * lib/docs/build.ts). Public, server-rendered pages; each composes the docs frame itself (components/docs/docs-frame),
 * so the navigation knows the page without any script.
 */
import type { ReactNode } from "react";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
