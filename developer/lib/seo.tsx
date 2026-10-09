/**
 * Search and answer-engine metadata for the public pages: one helper that gives every page its full set (title,
 * description, canonical, Open Graph, Twitter), and the Schema.org JSON-LD the pages embed. Next merges metadata
 * objects shallowly, so each page passes everything here rather than relying on a parent's openGraph.
 */
import type { Metadata } from "next";
import { CANONICAL_ORIGIN, LINKS, OG_IMAGE, ORGANIZATION, SITE_DESCRIPTION, SITE_NAME } from "./site";

export interface PageMeta {
  /** The page's own title; " · Silicon Developer" (or `suffix`) follows it unless `absoluteTitle`. */
  title: string;
  description: string;
  /** The page's path on the canonical origin: "/", "/docs/apps/start/install". */
  path: string;
  type?: "website" | "article";
  absoluteTitle?: boolean;
  suffix?: string;
  /** Alternate representations: { "text/markdown": "/docs/x.md" }. */
  types?: Record<string, string>;
  modified?: string | null;
  index?: boolean;
}

export const absolute = (path: string) => (path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`);

export function pageMetadata({ title, description, path, type = "website", absoluteTitle = false, suffix = SITE_NAME, types, modified, index = true }: PageMeta): Metadata {
  const url = absolute(path);
  const fullTitle = absoluteTitle ? title : `${title} · ${suffix}`;
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: url, types: { "text/plain": "/llms.txt", ...types } },
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      type,
      url,
      siteName: SITE_NAME,
      title: fullTitle,
      description,
      locale: "en_US",
      images: [{ ...OG_IMAGE, url: `${CANONICAL_ORIGIN}${OG_IMAGE.url}` }],
      ...(type === "article" && modified ? { modifiedTime: modified } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [`${CANONICAL_ORIGIN}${OG_IMAGE.url}`],
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* JSON-LD                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

const ORGANIZATION_ID = `${ORGANIZATION.url}/#organization`;
const WEBSITE_ID = `${CANONICAL_ORIGIN}/#website`;

export function organizationLd(): Json {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: ORGANIZATION.name,
    url: ORGANIZATION.url,
    logo: `${CANONICAL_ORIGIN}/icon-512.png`,
    email: ORGANIZATION.email,
    sameAs: [LINKS.accountsGithub, LINKS.appsGithub],
  };
}

export function websiteLd(): Json {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    url: `${CANONICAL_ORIGIN}/`,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORGANIZATION_ID },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${CANONICAL_ORIGIN}/docs/search?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbLd(crumbs: Crumb[]): Json {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: absolute(crumb.path) })),
  };
}

export function techArticleLd(page: { title: string; description: string; path: string; modified?: string | null; section?: string; markdown?: string; words?: number }): Json {
  return {
    "@type": "TechArticle",
    "@id": `${absolute(page.path)}#article`,
    headline: page.title,
    description: page.description,
    url: absolute(page.path),
    mainEntityOfPage: absolute(page.path),
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE_ID },
    author: { "@id": ORGANIZATION_ID },
    publisher: { "@id": ORGANIZATION_ID },
    image: `${CANONICAL_ORIGIN}${OG_IMAGE.url}`,
    ...(page.modified ? { dateModified: page.modified } : {}),
    ...(page.section ? { articleSection: page.section } : {}),
    ...(page.words ? { wordCount: page.words } : {}),
    ...(page.markdown ? { encoding: { "@type": "MediaObject", encodingFormat: "text/markdown", contentUrl: absolute(page.markdown) } } : {}),
  };
}

export function faqLd(entries: Array<{ question: string; answer: string }>): Json {
  return {
    "@type": "FAQPage",
    mainEntity: entries.map(entry => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
  };
}

/** One <script type="application/ld+json"> with a @graph. `<` is escaped so no string can close the script. */
export function JsonLd({ graph, nonce }: { graph: Json[]; nonce?: string }) {
  const body = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: body }} />;
}
