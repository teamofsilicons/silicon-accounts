/**
 * /docs: the Silicon Developer docs, rendered from the repository's docs/ (bundled at build time by
 * lib/docs/build.ts). Public pages: no session needed, outside the account shell.
 */
import type { Metadata } from "next";
import { DocsFrame } from "@/components/docs/docs-frame";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Silicon Developer docs" },
  description: "Documentation for Silicon Apps publishing and Silicon Accounts identity: guides, concepts, API references, and tools.",
  robots: { index: true, follow: true },
  alternates: { types: { "text/plain": "/llms.txt" } },
};

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return <DocsFrame>{children}</DocsFrame>;
}
