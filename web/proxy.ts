/**
 * Next 16 proxy (formerly middleware), run before every page: a fresh CSP nonce per request and the security headers
 * for pages. The API (/v1, /.well-known) and static files never pass through here: next.config.ts rewrites them to
 * the Rust API untouched (Set-Cookie, Location and Origin pass through), and they carry the API's own headers.
 *
 * - Content-Security-Policy with the nonce: script-src 'self' 'nonce-…' 'strict-dynamic' (Next adds the nonce to its
 *   own scripts; the root layout adds it to the theme boot script), style-src 'self' 'unsafe-inline', img-src 'self'
 *   https: data: blob: (plus a local stack's mock Iris, see localIrisImageSource), font-src 'self' data:,
 *   connect-src 'self', frame-ancestors 'none', form-action 'self' https:, base-uri 'none'. Development adds
 *   'unsafe-eval' (React's dev tooling needs it; production never does).
 * - X-Frame-Options DENY, nosniff, Referrer-Policy, and HSTS in production over https.
 * - /embed/v1/buttons: frame-ancestors 'self' <the app's allowed_origins> from GET /v1/apps/{app_id}/public (cached
 *   briefly), and no X-Frame-Options; none configured (or the field missing, or the app unknown) → frame-ancestors
 *   'none' and the page explains why when opened on its own.
 *
 * Request headers handed to the render: x-nonce, x-sa-surface (site | embed), x-sa-embed-framing (allowed | none).
 *
 * An address under an app's developer pages that names no tab (/developer/briefcase/bogus) is answered here with the
 * site's not-found page and a real 404: the page itself could only stream a "soft" 404 under a 200 once the shell's
 * layout has started.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isUnknownDeveloperTab } from "./lib/developer-tabs";

/** Where the Rust API listens (server side). Read at request time, so it can differ from the build's. */
const apiUrl = () => (process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:8589").replace(/\/+$/, "");
const isDev = process.env.NODE_ENV === "development";

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/;
const ORIGIN_TTL_MS = 30_000;
const originCache = new Map<string, { origins: string[]; until: number }>();

/** Keeps only clean `scheme://host[:port]` origins (the same rule as the API's own embed handler). */
function cleanOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    let origin: string;
    try {
      const url = new URL(entry.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      origin = url.origin;
    } catch {
      continue;
    }
    if (/[\s;,'"]/.test(origin) || origin === "null" || out.includes(origin)) continue;
    out.push(origin);
  }
  return out;
}

/**
 * The origins allowed to frame the embed for `appId`. The public config gains `allowed_origins` in the API; a config
 * without the field, an unknown or disabled app, or an unreachable API all mean "none configured" (fail closed).
 */
async function frameAncestors(appId: string | null): Promise<string[]> {
  const id = appId?.trim() ?? "";
  if (!APP_ID.test(id)) return [];
  const cached = originCache.get(id);
  if (cached && cached.until > Date.now()) return cached.origins;
  let origins: string[] = [];
  try {
    const response = await fetch(`${apiUrl()}/v1/apps/${encodeURIComponent(id)}/public`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) origins = cleanOrigins(((await response.json()) as { allowed_origins?: unknown }).allowed_origins);
  } catch {
    origins = [];
  }
  originCache.set(id, { origins, until: Date.now() + ORIGIN_TTL_MS });
  if (originCache.size > 500) originCache.delete(originCache.keys().next().value as string);
  return origins;
}

/**
 * Default profile photos come from Iris (ACCOUNTS_IRIS_BASE_URL, read at request time like ACCOUNTS_API_URL).
 * Production's Iris is https and already allowed by `https:`. A local stack points it at the testkit's mock Iris
 * (http://127.0.0.1:<port>), whose exact origin is added; only a loopback http origin is ever added.
 */
function localIrisImageSource(): string {
  const raw = process.env.ACCOUNTS_IRIS_BASE_URL?.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? ` ${url.origin}` : "";
  } catch {
    return "";
  }
}

function contentSecurityPolicy(nonce: string, frameAncestorsValue: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https: data: blob:${localIrisImageSource()}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestorsValue}`,
    "form-action 'self' https:",
    "base-uri 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const embed = pathname === "/embed/v1/buttons" || pathname.startsWith("/embed/");
  const ancestors = embed ? await frameAncestors(searchParams.get("app_id") ?? searchParams.get("client_id")) : [];
  const csp = contentSecurityPolicy(nonce, ancestors.length ? `'self' ${ancestors.join(" ")}` : "'none'");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-sa-surface", embed ? "embed" : "site");
  requestHeaders.set("x-sa-embed-framing", embed && ancestors.length ? "allowed" : "none");

  // No page lives here: render the not-found page (an address no route matches) with a 404 status.
  const response = isUnknownDeveloperTab(pathname)
    ? NextResponse.rewrite(new URL("/_sa/not-found", request.url), { status: 404, request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (!ancestors.length) response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  if (process.env.NODE_ENV === "production" && https) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [
    {
      // Everything except the API (rewritten to the Rust service), Next's static assets, the SDK and public files.
      source: "/((?!v1/|v1$|\\.well-known/|_next/static|_next/image|sdk/|favicon\\.ico|icon\\.svg|robots\\.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
