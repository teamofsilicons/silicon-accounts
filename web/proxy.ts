/**
 * Next 16 proxy (formerly middleware), run before every page: a fresh CSP nonce per request and the security headers
 * for pages. The API (/v1, /.well-known, /openapi.json), static files and the agent files (llms.txt, robots.txt,
 * sitemap.xml, the web manifest) never pass through here: next.config.ts rewrites the API paths to the Rust API
 * untouched (Set-Cookie, Location and Origin pass through), and the agent files are route handlers with headers of
 * their own.
 *
 * - Content-Security-Policy with the nonce: script-src 'self' 'nonce-…' 'strict-dynamic' (Next adds the nonce to its
 *   own scripts; the root layout adds it to the theme boot script), style-src 'self' 'unsafe-inline',
 *   img-src 'self' https: data: blob: (plus a local stack's mock Iris, see localIrisImageSource),
 *   font-src 'self' data:, connect-src 'self', frame-ancestors 'none', form-action 'self' https:, base-uri 'none'.
 *   Development adds 'unsafe-eval' (React's dev tooling needs it; production never does).
 * - X-Frame-Options DENY, nosniff, Referrer-Policy, and HSTS in production over https.
 * - /embed/v1/buttons: frame-ancestors 'self' <the app's allowed_origins> from GET /v1/apps/{app_id}/public (cached
 *   briefly), and no X-Frame-Options; none configured (or the field missing, or the app unknown) → frame-ancestors
 *   'none' and the page explains why when opened on its own.
 *
 * Request headers handed to the render: x-nonce, x-sa-surface and x-sa-embed-framing (allowed | none). The surface is
 *   public  "/" without a live session: rewritten to the landing page's own route (app/landing), server-rendered with
 *           no account shell and no client providers (its links are plain links, so leaving it is a full page load).
 *           A page load of "/" with a session cookie asks GET /v1/session first (staleSession); a cookie the API no
 *           longer accepts (401) gets the landing too, and is cleared, so the next load needs no question. Client
 *           navigations (RSC) never ask. A direct visit to /landing goes back to "/" (308).
 *   embed   /embed/v1/buttons, a transparent document inside an app's iframe
 *   site    everything else: the account pages, the hosted sign-in pages, device approval
 *
 * /developer and everything under it moved to the developer site (developers.teamofsilicons.com): a 307 to the address
 * GET /v1/meta names as `developer_url` (cached briefly; ACCOUNTS_DEVELOPER_URL, then the production address, when the
 * API cannot say). /developer → its home, /developer/{app_id}[/{tab}] → /apps/{app_id}[/{tab}] there, query kept.
 *
 * Documentation moved to the same developer site: permanent 308 redirects preserve deep paths and queries.
 * Old Accounts articles and Markdown live under /docs/accounts; /docs is shared. /llms.txt and /llms-full.txt are this
 * site's own (app/llms.txt, app/llms-full.txt: web/llms/ as written).
 */
import { NextResponse, type NextRequest } from "next/server";
import { developerDocsPath } from "@/lib/docs-redirects";
import { apiUrl, developerUrl } from "@/lib/server/meta";
import { SESSION_COOKIES, hasSessionCookie } from "@/lib/server/session";

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

/** Where an old /developer address of this site lives on the developer site. */
async function developerRedirect(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const rest = pathname.replace(/^\/developer\/?/, "").replace(/\/+$/, "");
  const target = new URL(`${await developerUrl()}/`);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${rest ? `/apps/${rest}` : "/"}`;
  target.search = search;
  return NextResponse.redirect(target, 307);
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

/**
 * Whether the session cookie on a page load of "/" is one the API no longer accepts: true only on a 401 from
 * GET /v1/session. Anything else (signed in, the API slow or unreachable) is false, and the account shell decides in
 * the browser as before. The client's forwarded address goes along, so the API counts the call against the client.
 */
async function staleSession(request: NextRequest): Promise<boolean> {
  const cookie = request.headers.get("cookie");
  if (!hasSessionCookie(cookie)) return false;
  const headers: Record<string, string> = { Accept: "application/json", Cookie: cookie ?? "" };
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) headers["X-Forwarded-For"] = forwarded;
  try {
    const response = await fetch(`${apiUrl()}/v1/session`, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(2500) });
    await response.body?.cancel();
    return response.status === 401;
  } catch {
    return false;
  }
}

/** Clears the session cookies a request carried (the API's own attributes: Path=/, HttpOnly, SameSite=Lax). */
function clearSessionCookies(request: NextRequest, response: NextResponse): void {
  for (const name of SESSION_COOKIES) {
    if (!request.cookies.has(name)) continue;
    response.cookies.set({ name, value: "", path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: name.startsWith("__Host-") });
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
  if (pathname === "/developer" || pathname.startsWith("/developer/")) return developerRedirect(request);
  const docsPath = developerDocsPath(pathname);
  if (docsPath) {
    const target = new URL(`${await developerUrl()}/`);
    target.pathname = `${target.pathname.replace(/\/+$/, "")}${docsPath}`;
    target.search = request.nextUrl.search;
    // Fragments are never sent in HTTP requests. Omitting a fragment in Location lets the browser inherit it.
    return NextResponse.redirect(target, 308);
  }
  // The landing page lives at "/" only.
  if (pathname === "/landing" || pathname.startsWith("/landing/")) return NextResponse.redirect(new URL(`/${request.nextUrl.search}`, request.url), 308);
  const nonce = btoa(crypto.randomUUID());
  const embed = pathname === "/embed/v1/buttons" || pathname.startsWith("/embed/");
  // "/" is public without a session cookie, and with one the API no longer accepts (asked on page loads only).
  const pageLoad = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("rsc");
  const stale = pathname === "/" && pageLoad && (await staleSession(request));
  const surface = embed ? "embed" : pathname === "/" && (stale || !hasSessionCookie(request.headers.get("cookie"))) ? "public" : "site";
  const ancestors = embed ? await frameAncestors(searchParams.get("app_id") ?? searchParams.get("client_id")) : [];
  const csp = contentSecurityPolicy(nonce, ancestors.length ? `'self' ${ancestors.join(" ")}` : "'none'");

  const requestHeaders = new Headers(request.headers);
  // The render must not see a cookie the API refused (the root layout reads it as a hint of a session).
  if (stale) requestHeaders.set("cookie", (request.headers.get("cookie") ?? "").split(";").filter(part => !(SESSION_COOKIES as readonly string[]).includes(part.split("=")[0]?.trim() ?? "")).join(";"));
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-sa-surface", surface);
  requestHeaders.set("x-sa-embed-framing", embed && ancestors.length ? "allowed" : "none");

  const response = surface === "public"
    ? NextResponse.rewrite(new URL(`/landing${request.nextUrl.search}`, request.url), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  if (stale) clearSessionCookies(request, response);
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
    // Documentation must redirect even for prefetch/RSC requests and generated static Markdown files.
    "/docs/:path*", "/docs.md",
    {
      // Everything except the API (rewritten to the Rust service), Next's static assets, the SDK, public files and the
      // agent files (route handlers with their own headers).
      source: "/((?!v1/|v1$|\\.well-known/|openapi\\.json|_next/static|_next/image|sdk/|fonts/|favicon\\.ico|icon\\.svg|icon-\\d+\\.png|icon-maskable-\\d+\\.png|apple-touch-icon\\.png|og\\.png|robots\\.txt|sitemap\\.xml|llms\\.txt|llms-full\\.txt|manifest\\.webmanifest).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
