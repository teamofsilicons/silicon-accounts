/**
 * Server-side settings of the developer site, read from the environment at request time (never baked into the build),
 * so one build serves every stack. Only route handlers and proxy.ts import this file.
 *
 *   ACCOUNTS_API_URL          where the Silicon Accounts API listens, server to server   [http://127.0.0.1:8589]
 *   ACCOUNTS_PUBLIC_URL       the browser-facing accounts site (hosted sign-in, SDK)      [dev http://localhost:8590,
 *                                                                                          prod https://accounts.teamofsilicons.com]
 *   DEVELOPER_PUBLIC_URL      this site's own origin (also read as ACCOUNTS_DEVELOPER_URL) [dev http://localhost:$PORT (8600),
 *                                                                                          prod https://developer.teamofsilicons.com]
 *   DEVELOPER_SESSION_SECRET  seals the session cookies, at least 32 characters; production refuses to run without it
 *   DEVELOPER_EXTRA_ORIGINS   more origins the same-origin guard accepts (comma separated)
 *   ACCOUNTS_IRIS_BASE_URL    a loopback mock Iris is added to the CSP's img-src (local stacks), like web/proxy.ts
 */

/** The first-party app this site signs Carbons in through (a public client: PKCE, no secret). */
export const DEVELOPER_APP_ID = "developer";

const isProduction = () => process.env.NODE_ENV === "production";
const trimSlash = (value: string) => value.trim().replace(/\/+$/, "");

/** The origin of a URL, or null when it does not parse. */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function accountsApiUrl(): string {
  return trimSlash(process.env.ACCOUNTS_API_URL || "http://127.0.0.1:8589");
}

export function accountsPublicUrl(): string {
  const value = process.env.ACCOUNTS_PUBLIC_URL;
  if (value?.trim()) return trimSlash(value);
  return isProduction() ? "https://accounts.teamofsilicons.com" : "http://localhost:8590";
}

export function developerPublicUrl(): string {
  const value = process.env.DEVELOPER_PUBLIC_URL || process.env.ACCOUNTS_DEVELOPER_URL;
  if (value?.trim()) return trimSlash(value);
  return isProduction() ? "https://developer.teamofsilicons.com" : `http://localhost:${process.env.PORT || "8600"}`;
}

/** The redirect URI registered for the `developer` app: exactly `{DEVELOPER_PUBLIC_URL}/auth/callback`. */
export function callbackUrl(): string {
  return `${developerPublicUrl()}/auth/callback`;
}

/** Cookies are Secure (and `__Host-` prefixed) when this site is served over https. */
export function secureCookies(): boolean {
  return developerPublicUrl().startsWith("https://");
}

/** Origins allowed to send state-changing requests to the BFF (the same-origin guard). */
export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  const own = originOf(developerPublicUrl());
  if (own) out.add(own);
  for (const entry of (process.env.DEVELOPER_EXTRA_ORIGINS ?? "").split(",")) {
    const origin = originOf(entry.trim());
    if (origin) out.add(origin);
  }
  if (!isProduction() && own) {
    // A local stack is opened as localhost or 127.0.0.1 interchangeably.
    const url = new URL(own);
    for (const host of ["localhost", "127.0.0.1"]) out.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
  }
  return out;
}

/** The development secret. It is written here, so anyone can read it: production refuses it. */
export const DEV_SECRET = "silicon-accounts-developer-site-dev-only-session-secret-0001";
let warned = false;

/**
 * The secret the session cookies are sealed with. Development has a fixed, public one; production must set its own, and
 * refuses a missing one, a short one, or the public development secret (cookies sealed with it could be opened, and
 * forged, by anyone who read this file).
 */
export function sessionSecret(): string {
  const value = process.env.DEVELOPER_SESSION_SECRET?.trim();
  if (isProduction()) {
    if (!value) throw new Error("DEVELOPER_SESSION_SECRET is not set. The developer site seals its session cookies with it; set at least 32 random characters (openssl rand -base64 48).");
    if (value.length < 32) throw new Error(`DEVELOPER_SESSION_SECRET is ${value.length} characters; it must be at least 32 (generate one with: openssl rand -base64 48).`);
    if (value === DEV_SECRET) throw new Error("DEVELOPER_SESSION_SECRET is the public development secret from the developer site's source; anyone could open or forge its cookies. Generate one with: openssl rand -base64 48.");
    return value;
  }
  if (value && value.length >= 32) return value;
  if (!warned) {
    warned = true;
    console.warn("developer site: DEVELOPER_SESSION_SECRET is not set, so session cookies are sealed with the public development secret. Never run like this in production.");
  }
  return DEV_SECRET;
}

/** A loopback http origin of the mock Iris, for the CSP's img-src (production's https Iris is covered by `https:`). */
export function localIrisImageSource(): string | null {
  const raw = process.env.ACCOUNTS_IRIS_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? url.origin : null;
  } catch {
    return null;
  }
}
