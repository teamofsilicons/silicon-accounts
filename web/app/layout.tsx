/**
 * The root layout: <html> and <body> for every page, the site's faces and tokens over Arc's foundation and the no-flash
 * theme boot script (inline, with the request's CSP nonce). It ships no client code of its own: the account pages and
 * the hosted pages mount their providers in app/(app)/layout.tsx, so the public landing page (app/landing) stays
 * server-rendered HTML with a few small islands.
 *
 * Three surfaces share it, told apart by proxy.ts through the `x-sa-surface` request header:
 *   public  the landing page at "/" for a browser without a live session, with the Organization and WebSite JSON-LD
 *   site    the account site and the hosted sign-in pages
 *   embed   /embed/v1/buttons, a transparent document inside an app's iframe (no theme boot)
 * Every page is rendered per request (the nonce changes each time), so `headers()` is fine here.
 */
import "@/components/silicon-ui/foundation.css";
import "@/styles/fonts.css";
import "@/styles/tokens.css";
import "@/styles/squircle.css";
import "@/styles/branding.css";
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
  // Account pages are private and hosted sign-in pages are not for search engines; the landing page opens itself.
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

type Surface = "public" | "site" | "embed";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  const asked = requestHeaders.get("x-sa-surface");
  const surface: Surface = asked === "embed" || asked === "public" ? asked : "site";

  return (
    <html lang="en" className={brandFontVariables} data-surface={surface} suppressHydrationWarning>
      <head>
        {surface !== "embed" ? (
          <>
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
            {/* Page titles are set in DemiBold: the one weight worth fetching before first paint. */}
            <link rel="preload" href="/fonts/bdo-grotesk/BDOGrotesk-DemiBold.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
          </>
        ) : null}
      </head>
      <body>
        {children}
        {surface === "public" ? <JsonLd nonce={nonce} graph={[organizationLd(), websiteLd()]} /> : null}
      </body>
    </html>
  );
}
