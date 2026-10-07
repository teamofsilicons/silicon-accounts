/**
 * The root layout: <html> and <body> for every page, the three site fonts, the brand tokens over Arc's foundation, the
 * no-flash theme boot script (inline, with the request's CSP nonce) and the shared providers.
 *
 * Two surfaces share it, told apart by proxy.ts through the `x-sa-surface` request header:
 *   site   the account site, the docs and the hosted sign-in pages
 *   embed  /embed/v1/buttons, a transparent document inside an app's iframe (no theme boot, no toasts)
 * Every page is rendered per request (the nonce changes each time), so `headers()` and `cookies()` are fine here.
 */
import "@/components/arc/foundation.css";
import "@/styles/tokens.css";
import "@/styles/squircle.css";
import "@/styles/branding.css";
import "@/styles/base.css";
import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  title: { default: "Silicon Accounts", template: "%s · Silicon Accounts" },
  description: "One account for every Carbon and Silicon. Manage your identity, the apps you sign into, your Silicons and your proofs.",
  applicationName: "Silicon Accounts",
  referrer: "strict-origin-when-cross-origin",
  robots: { index: true, follow: true },
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

/** Cookie names of the browser session (`__Host-` when the API runs with secure cookies). */
const SESSION_COOKIES = ["sa_session", "__Host-sa_session"];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  const surface = requestHeaders.get("x-sa-surface") === "embed" ? "embed" : "site";
  // No session cookie means signed out for sure: the landing page can render on the server instead of after a
  // round trip. With a cookie, the client asks GET /v1/session (the cookie may have expired).
  const jar = await cookies();
  const sessionHint = SESSION_COOKIES.some(name => jar.has(name)) ? "cookie" : "none";

  return (
    <html lang="en" className={fontVariables} data-surface={surface} suppressHydrationWarning>
      <head>
        {surface === "site" ? <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /> : null}
      </head>
      <body>
        <Providers surface={surface} sessionHint={sessionHint}>{children}</Providers>
      </body>
    </html>
  );
}
