/**
 * Whether a request carries the browser session cookie (`sa_session`, or `__Host-sa_session` when the API runs with
 * secure cookies). No cookie means signed out for sure, so the landing page renders on the server; a cookie may still
 * have expired, which only the API can tell (the client asks GET /v1/session).
 */
export const SESSION_COOKIES = ["sa_session", "__Host-sa_session"] as const;

/** From a Cookie header (proxy.ts) or a cookie jar's names (server components). */
export function hasSessionCookie(source: string | null | undefined | { has(name: string): boolean }): boolean {
  if (!source) return false;
  if (typeof source !== "string") return SESSION_COOKIES.some(name => source.has(name));
  return source.split(";").some(part => {
    const name = part.split("=")[0]?.trim();
    return !!name && (SESSION_COOKIES as readonly string[]).includes(name);
  });
}
