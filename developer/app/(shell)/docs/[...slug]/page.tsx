/**
 * /docs/<path>: one page of the docs (docs/<path>.md), or a group's page (/docs/start, /docs/learn, /docs/reference).
 * The page's Markdown is at /docs/<path>.md (a static file in public/docs, written by lib/docs/build.ts).
 */
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { DocArticle, GroupPage } from "@/components/docs/doc-article";
import { findPage, groupPages, isGroup } from "@/lib/docs/content";
import { DOCS_BASE, sectionInfo } from "@/lib/docs/site";

function pathOf(slug: string[]): string {
  return slug.map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }).join("/");
}

export async function generateMetadata({ params }: PageProps<"/docs/[...slug]">): Promise<Metadata> {
  const path = pathOf((await params).slug);
  const page = findPage(path);
  if (page) {
    return {
      title: page.title,
      description: page.description || undefined,
      alternates: { canonical: `https://developers.teamofsilicons.com${page.href}`, types: { "text/markdown": page.rawHref } },
    };
  }
  if (isGroup(path)) {
    return { title: groupPages(path)[0]?.groupLabel ?? path, description: sectionInfo(path)?.summary, alternates: { canonical: `https://developers.teamofsilicons.com/docs/${path}` } };
  }
  return { title: "Page not found" };
}

export default async function DocsPage({ params }: PageProps<"/docs/[...slug]">) {
  const path = pathOf((await params).slug);
  // docs/index.md is the landing page itself.
  if (path === "index") permanentRedirect(DOCS_BASE);
  if (/^(apps|accounts)\/index$/.test(path)) permanentRedirect(`${DOCS_BASE}/${path.split("/")[0]}`);
  const page = findPage(path);
  if (page) return <DocArticle page={page} />;
  if (isGroup(path)) return <GroupPage group={path} />;
  notFound();
}
