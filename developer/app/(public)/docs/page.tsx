/** /docs: the docs landing page (lib/docs/landing.md). */
import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { DocsFrame } from "@/components/docs/docs-frame";
import { NoDocs } from "@/components/docs/no-docs";
import { findPage } from "@/lib/docs/content";
import { pageMetadata } from "@/lib/seo";

export function generateMetadata(): Metadata {
  const page = findPage("");
  return pageMetadata({
    title: "Silicon Developer docs",
    absoluteTitle: true,
    description: page?.description ?? "Documentation for Silicon Apps and Silicon Accounts: guides, explanations and references.",
    path: "/docs",
    types: { "text/markdown": "/docs/index.md" },
    modified: page?.modified,
  });
}

export default function DocsHome() {
  const page = findPage("");
  return <DocsFrame path="/docs">{page ? <DocArticle page={page} /> : <NoDocs />}</DocsFrame>;
}
