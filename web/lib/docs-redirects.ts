/**
 * Legacy Accounts documentation addresses on the shared developer portal. /llms.txt and /llms-full.txt are not among
 * them: this site serves its own (web/llms/).
 */
export function developerDocsPath(pathname: string): string | null {
  if (pathname === "/docs" || pathname === "/docs/") return "/docs";
  if (pathname === "/docs.md") return "/docs/accounts/index.md";
  if (pathname === "/docs/search-index.json") return pathname;
  if (pathname.startsWith("/docs/")) return `/docs/accounts/${pathname.slice("/docs/".length)}`;
  return null;
}
