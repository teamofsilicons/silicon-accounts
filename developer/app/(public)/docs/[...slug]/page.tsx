/**
 * /docs/<path>: one page of the docs (docs/<path>.md or docs-apps/<path>.md under its product), or a group's page
 * (/docs/apps/start, /docs/accounts/reference). The page's Markdown is at /docs/<path>.md (a static file in
 * public/docs, written by lib/docs/build.ts).
 */
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { DocArticle, GroupPage } from "@/components/docs/doc-article";
import { DocsFrame } from "@/components/docs/docs-frame";
import { findPage, groupPages, isGroup } from "@/lib/docs/content";
import { DOCS_BASE, sectionInfo } from "@/lib/docs/site";
import { pageMetadata } from "@/lib/seo";

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
    return pageMetadata({
      title: page.title,
      // A product's own overview is already called "Silicon Apps docs": its title needs only the site's name after it.
      suffix: /^(apps|accounts)\/index\.md$/.test(page.path) ? "Silicon Developer" : page.path.startsWith("apps/") ? "Silicon Apps docs" : page.path.startsWith("accounts/") ? "Silicon Accounts docs" : "Silicon Developer docs",
      description: page.description || `${page.title}, from the Silicon Developer docs.`,
      path: page.href,
      type: "article",
      types: { "text/markdown": page.rawHref },
      modified: page.modified,
    });
  }
  if (isGroup(path)) {
    const label = groupPages(path)[0]?.groupLabel ?? path;
    return pageMetadata({ title: label, suffix: "Silicon Developer docs", description: sectionInfo(path)?.summary ?? label, path: `${DOCS_BASE}/${path}` });
  }
  return { title: { absolute: "Page not found · Silicon Developer docs" }, robots: { index: false, follow: true } };
}

export default async function DocsPage({ params }: PageProps<"/docs/[...slug]">) {
  const path = pathOf((await params).slug);
  // docs/index.md is the landing page itself.
  if (path === "index") permanentRedirect(DOCS_BASE);
  if (/^(apps|accounts)\/index$/.test(path)) permanentRedirect(`${DOCS_BASE}/${path.split("/")[0]}`);
  const page = findPage(path);
  if (page) return <DocsFrame path={page.href}><DocArticle page={page} /></DocsFrame>;
  if (isGroup(path)) return <DocsFrame path={`${DOCS_BASE}/${path}`}><GroupPage group={path} /></DocsFrame>;
  notFound();
}
