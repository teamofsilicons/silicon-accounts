/**
 * The root layout of developers.teamofsilicons.com: <html> and <body>, the three site fonts, the brand tokens over Arc's
 * foundation, the no-flash theme boot script (inline, with the request's CSP nonce) and the shared providers. Every
 * page renders per request (the nonce changes each time).
 */
import "@/components/arc/foundation.css";
import "@/styles/tokens.css";
import "@/styles/squircle.css";
import "@/styles/branding.css";
import "@/styles/base.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  title: { default: "Silicon Developer", template: "%s · Silicon Developer" },
  description: "Publish through Silicon Apps and configure Silicon Accounts: methods, Google and Apple, details, flows, pages, users, webhooks and ATA proofs.",
  applicationName: "Silicon Developer",
  referrer: "strict-origin-when-cross-origin",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFDF9" },
    { media: "(prefers-color-scheme: dark)", color: "#2A2927" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={fontVariables} data-surface="site" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
