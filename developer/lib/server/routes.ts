/**
 * What the BFF proxy forwards (app/api/accounts/[...path]/route.ts): the developer audience's allowlist (06-v2 §2),
 * plus the public reads the pages need. Framework-free, so it is testable on its own.
 *
 *   GET  meta, apps/{id}/public, .well-known/openid-configuration, .well-known/jwks.json   (public: sent without a token)
 *   GET  me, me/owned-apps                                                                (the signed-in Carbon)
 *   ANY  apps/{id}, apps/{id}/…                                                            (the app's owner routes)
 */
const APP = "[a-z][a-z0-9-]{1,39}";
const PUBLIC_GET = [/^v1\/meta$/, new RegExp(`^v1/apps/${APP}/public$`), /^\.well-known\/(openid-configuration|jwks\.json)$/];
const ACCOUNT_GET = [/^v1\/me$/, /^v1\/me\/owned-apps$/];
const OWNER = new RegExp(`^v1/apps/${APP}(/[A-Za-z0-9._~%:@-]+)*$`);

export type ProxyKind = "public" | "account";

/**
 * The upstream path (`v1/apps/briefcase/users`) for the part of the address after `/api/accounts/` (still
 * percent-encoded), and whether it carries the account's token; null when the BFF does not forward it.
 */
export function proxyRoute(rest: string, method: string): { path: string; kind: ProxyKind } | null {
  const path = rest.startsWith(".well-known/") ? rest : `v1/${rest}`;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || /%2e/i.test(segment) || /%2f/i.test(segment) || /%5c/i.test(segment))) return null;
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") {
    if (PUBLIC_GET.some(pattern => pattern.test(path))) return { path, kind: "public" };
    if (ACCOUNT_GET.some(pattern => pattern.test(path))) return { path, kind: "account" };
  }
  if (OWNER.test(path) && !/^v1\/apps\/[^/]+\/public$/.test(path)) return { path, kind: "account" };
  return null;
}
