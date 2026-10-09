/**
 * Search and answer-engine metadata for the public pages: one helper that gives every page its full set (title,
 * description, canonical, Open Graph, Twitter), and the Schema.org JSON-LD the pages embed (the same shapes as the
 * developer site's lib/seo.tsx). Next merges metadata objects shallowly, so each page passes everything here rather
 * than relying on a parent's openGraph.
 */
import type { Metadata } from "next";
import { CANONICAL_ORIGIN, LINKS, OG_IMAGE, ORGANIZATION, SITE_DESCRIPTION, SITE_NAME } from "./site";

export interface PageMeta {
  /** The page's own title; " · Silicon Accounts" follows it unless `absoluteTitle`. */
  title: string;
  description: string;
  /** The page's path on the canonical origin: "/". */
  path: string;
  type?: "website" | "article";
  absoluteTitle?: boolean;
  index?: boolean;
}

export const absolute = (path: string) => (path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`);

export function pageMetadata({ title, description, path, type = "website", absoluteTitle = false, index = true }: PageMeta): Metadata {
  const url = absolute(path);
  const fullTitle = absoluteTitle ? title : `${title} · ${SITE_NAME}`;
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: url, types: { "text/plain": "/llms.txt" } },
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      type,
      url,
      siteName: SITE_NAME,
      title: fullTitle,
      description,
      locale: "en_US",
      images: [{ ...OG_IMAGE, url: `${CANONICAL_ORIGIN}${OG_IMAGE.url}` }],
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

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export const ORGANIZATION_ID = `${ORGANIZATION.url}/#organization`;
export const WEBSITE_ID = `${CANONICAL_ORIGIN}/#website`;
export const APPLICATION_ID = `${CANONICAL_ORIGIN}/#application`;

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
  };
}

/** Silicon Accounts itself, as an application people and agents use (web, and the CLI on three systems). */
export function applicationLd(): Json {
  return {
    "@type": ["WebApplication", "SoftwareApplication"],
    "@id": APPLICATION_ID,
    name: SITE_NAME,
    url: `${CANONICAL_ORIGIN}/`,
    description: SITE_DESCRIPTION,
    applicationCategory: "SecurityApplication",
    applicationSubCategory: "Identity and sign-in",
    operatingSystem: "Web, macOS, Linux, Windows",
    browserRequirements: "Any modern browser. Silicons need no browser: the silicon-accounts CLI and the API do everything.",
    image: `${CANONICAL_ORIGIN}${OG_IMAGE.url}`,
    screenshot: `${CANONICAL_ORIGIN}${OG_IMAGE.url}`,
    featureList: [
      "One account for every app in the Silicon ecosystem",
      "Silicon accounts for agents, with a Carbon as custodian",
      "Sign in without a browser with short-lived tokens (SLT)",
      "Sign in with Google, Apple, or a code by email or phone",
      "See and remove the apps you signed into",
      "See and revoke User verifications",
      "Create Silicons, rotate their STK and transfer them",
      "OpenID Connect, OAuth 2.0 and an OpenAPI description",
    ],
    softwareHelp: { "@type": "CreativeWork", url: LINKS.developerDocs },
    license: LINKS.accountsLicense,
    isAccessibleForFree: true,
    publisher: { "@id": ORGANIZATION_ID },
    provider: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
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
