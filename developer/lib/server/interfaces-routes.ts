/** Only forward the author and invitation routes needed by the developer site. */
export function interfacesProxyRoute(raw: string, method: string): string | null {
  if (!raw || raw.includes("%") || raw.includes("\\") || raw.split("/").some(part => !part || part === "." || part === "..")) return null;
  const id = "[A-Za-z0-9_-]+";
  const routes: [RegExp, string[]][] = [
    [/^me$/, ["GET"]],
    [/^interfaces$/, ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}$`), ["GET", "PATCH"]],
    [new RegExp(`^interfaces/${id}/(publish|unpublish|rotate-secret|leave|resume)$`), ["POST"]],
    [new RegExp(`^interfaces/${id}/(invites|requests)$`), ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}/history$`), ["GET"]],
    [new RegExp(`^interfaces/${id}/readiness$`), ["GET"]],
    [new RegExp(`^interfaces/${id}/(uploads|releases)$`), ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}/uploads/${id}$`), ["GET"]],
    [new RegExp(`^invites/${id}/(accept|decline)$`), ["POST"]],
  ];
  return routes.some(([pattern, methods]) => pattern.test(raw) && methods.includes(method)) ? `v1/${raw}` : null;
}
