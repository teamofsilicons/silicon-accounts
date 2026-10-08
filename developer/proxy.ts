/**
 * Next 16 proxy (formerly middleware), run before every page: a fresh CSP nonce per request and the security headers.
 * The BFF's route handlers (/api/accounts/*, /auth/*) and static files never pass through here (their bodies must not be
 * buffered, see proxyClientMaxBodySize); they set their own headers.
 *
 * - Content-Security-Policy with the nonce: script-src 'self' 'nonce-…' 'strict-dynamic' (Next adds the nonce to its own
 *   scripts; the root layout adds it to the theme boot script; the Embed tab's live preview loads the accounts site's
 *   /sdk/v1.js from trusted script), connect-src 'self' plus the accounts site (the SDK reads the app's public setup
 *   there), img-src 'self' https: data: blob: plus the accounts site and a local stack's mock Iris, frame-ancestors
 *   'none'. Development adds 'unsafe-eval' (React's dev tooling).
 * - X-Frame-Options DENY, nosniff, Referrer-Policy, and HSTS in production over https.
 *
 * An address under an app that names no tab (/apps/briefcase/bogus) is answered with the not-found page and a real 404;
 * the account site's old tab names (branding, proofs) redirect to their tabs here (pages, ata).
 */
import { NextResponse, type NextRequest } from "next/server";
import { findPage, findPageByPath, isGroup } from "./lib/docs/content";
import { isUnknownAppTab, renamedAppTab } from "./lib/app-tabs";
import { accountsPublicUrl, localIrisImageSource, originOf } from "./lib/server/config";

const isDev = process.env.NODE_ENV === "development";

function contentSecurityPolicy(nonce: string): string {
  const accounts = originOf(accountsPublicUrl());
  const extra = (value: string | null) => (value ? ` ${value}` : "");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${extra(accounts)}${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https: data: blob:${extra(accounts)}${extra(localIrisImageSource())}`,
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${extra(accounts)}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
  ].join("; ");
}

/** Resolve docs before streaming so unknown URLs have a real HTTP 404. */
function docsAddressMissing(pathname: string): boolean {
  if (!pathname.startsWith("/docs/")) return false;
  let path: string;
  try { path = decodeURIComponent(pathname.slice(6)).replace(/\/+$/, ""); } catch { return true; }
  if (!path || path === "search-index.json" || path === "index" || /^(apps|accounts)\/index$/.test(path)) return false;
  return path.endsWith(".md") ? !findPageByPath(path) : !findPage(path) && !isGroup(path);
}

export function proxy(request: NextRequest) {
  // The account site's old developer tabs (its /developer redirects keep their names): Branding is Pages, Proofs is ATA.
  const renamed = renamedAppTab(request.nextUrl.pathname);
  if (renamed) {
    const target = new URL(request.url);
    target.pathname = renamed;
    return NextResponse.redirect(target, 308);
  }
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = docsAddressMissing(request.nextUrl.pathname)
    ? NextResponse.rewrite(new URL("/docs/404", request.url), { status: 404, request: { headers: requestHeaders } })
    : isUnknownAppTab(request.nextUrl.pathname)
    ? NextResponse.rewrite(new URL("/_dev/not-found", request.url), { status: 404, request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  if (process.env.NODE_ENV === "production" && https) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|auth/|_next/static|_next/image|favicon\\.ico|icon\\.svg|robots\\.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
