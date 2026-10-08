/** Publishing-only paths. Store browsing, reviews, installation and account settings stay outside this proxy. */
const APP = "[a-z0-9_-]{3,30}";
const RESOURCE = "[A-Za-z0-9_-]+";
const routes: [string, RegExp][] = [
  ["GET HEAD", /^me$/],
  ["GET HEAD", /^targets$/],
  ["POST", /^telemetry$/],
  ["GET HEAD POST", /^apps$/],
  ["GET HEAD", new RegExp(`^apps/availability/${APP}$`)],
  ["GET HEAD PATCH", new RegExp(`^apps/${APP}$`)],
  ["PUT", new RegExp(`^apps/${APP}/access$`)],
  ["GET HEAD", new RegExp(`^apps/${APP}/(packages|releases|authors|invites|history|readiness)$`)],
  ["POST", new RegExp(`^apps/${APP}/(media|releases|invites|publish|admin|authors/leave|secret/rotate|webhook/rotate)$`)],
  ["POST", new RegExp(`^apps/${APP}/packages/${RESOURCE}$`)],
  ["GET HEAD", new RegExp(`^apps/${APP}/media/${RESOURCE}$`)],
  ["GET HEAD PUT", new RegExp(`^apps/${APP}/webhook$`)],
  ["POST", new RegExp(`^apps/${APP}/releases/${RESOURCE}/promote$`)],
  ["DELETE", new RegExp(`^apps/${APP}/(authors|invites)/${RESOURCE}$`)],
  ["GET HEAD", /^invites$/],
  ["POST", new RegExp(`^invites/${RESOURCE}/(accept|decline)$`)],
];
export function proxyRoute(rest: string, method: string, query = new URLSearchParams()): {path: string} | null {
  if (rest.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.includes("%") || segment.includes("\\"))) return null;
  const verb = method.toUpperCase();
  // The developer portal lists only the signed-in account's apps, never the store catalog.
  if (rest === "apps" && (verb === "GET" || verb === "HEAD") && query.get("mine") !== "true") return null;
  return routes.some(([methods, pattern]) => methods.split(" ").includes(verb) && pattern.test(rest)) ? {path: `v1/${rest}`} : null;
}
