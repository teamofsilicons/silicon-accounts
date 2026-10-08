/** Legacy Accounts documentation addresses on the shared developer portal. */
export function developerDocsPath(pathname: string): string | null {
  if (pathname === "/docs" || pathname === "/docs/") return "/docs";
  if (pathname === "/docs.md") return "/docs/accounts/index.md";
  if (pathname === "/llms.txt" || pathname === "/llms-full.txt") return pathname;
  if (pathname === "/docs/search-index.json") return pathname;
  if (pathname.startsWith("/docs/")) return `/docs/accounts/${pathname.slice("/docs/".length)}`;
  return null;
}
