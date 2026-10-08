/** /docs: the landing page (docs/index.md). */
import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { NoDocs } from "@/components/docs/no-docs";
import { findPage } from "@/lib/docs/content";

export function generateMetadata(): Metadata {
  const page = findPage("");
  return {
    title: page?.title ?? "Docs",
    description: page?.description,
    alternates: { canonical: "https://developers.teamofsilicons.com/docs", types: { "text/markdown": "/docs/index.md", "text/plain": "/llms.txt" } },
  };
}

export default function DocsHome() {
  const page = findPage("");
  return page ? <DocArticle page={page} /> : <NoDocs />;
}
