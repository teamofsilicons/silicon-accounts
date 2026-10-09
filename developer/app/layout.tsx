/**
 * The root layout of developers.teamofsilicons.com: <html> and <body>, the site's faces and tokens over Arc's
 * foundation, the no-flash theme boot script (inline, with the request's CSP nonce), and the Organization and WebSite
 * JSON-LD every page carries. It ships no client code of its own: the public pages (the home page and the docs) stay
 * server-rendered HTML with a few small islands, and the signed-in portal mounts its providers in app/(shell)/layout.tsx.
 * Every page renders per request (the nonce changes each time).
 */
import "@/components/arc/foundation.css";
import "@/styles/fonts.css";
import "@/styles/tokens.css";
import "@/styles/squircle.css";
import "@/styles/base.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { JsonLd, organizationLd, websiteLd } from "@/lib/seo";
import { CANONICAL_ORIGIN, OG_IMAGE, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { brandFontVariables } from "./fonts";

export const metadata: Metadata = {
  metadataBase: new URL(CANONICAL_ORIGIN),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  referrer: "strict-origin-when-cross-origin",
  // The signed-in portal is private; app/(public)/layout.tsx opens the public pages to search engines.
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "32x32" }, { url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", images: [{ ...OG_IMAGE, url: `${CANONICAL_ORIGIN}${OG_IMAGE.url}` }] },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F8FA" },
    { media: "(prefers-color-scheme: dark)", color: "#02040A" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={brandFontVariables} data-surface="site" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {/* Page titles are set in DemiBold: the one weight worth fetching before first paint. */}
        <link rel="preload" href="/fonts/bdo-grotesk/BDOGrotesk-DemiBold.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        {children}
        <JsonLd nonce={nonce} graph={[organizationLd(), websiteLd()]} />
      </body>
    </html>
  );
}
