/** Only forward the author and invitation routes needed by the developer site. */
export function interfacesProxyRoute(raw: string, method: string): string | null {
  if (!raw || raw.includes("%") || raw.includes("\\") || raw.split("/").some(part => !part || part === "." || part === "..")) return null;
  const id = "[A-Za-z0-9_-]+";
  const routes: [RegExp, string[]][] = [
    [/^(me|people)$/, ["GET"]],
    [new RegExp(`^interfaces/${id}/organization-access$`), ["PUT"]],
    [new RegExp(`^interfaces/${id}/organization-authors/[a-z0-9_-]{3,30}$`), ["DELETE"]],
    [/^interfaces$/, ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}$`), ["GET", "PATCH", "DELETE"]],
    [new RegExp(`^interfaces/${id}/(publish|unpublish|restore|rotate-secret|leave|resume)$`), ["POST"]],
    [new RegExp(`^interfaces/${id}/(invites|requests)$`), ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}/history$`), ["GET"]],
    [new RegExp(`^interfaces/${id}/readiness$`), ["GET"]],
    [new RegExp(`^interfaces/${id}/(uploads|releases)$`), ["GET", "POST"]],
    [new RegExp(`^interfaces/${id}/uploads/${id}$`), ["GET"]],
    [new RegExp(`^invites/${id}/(accept|decline)$`), ["POST"]],
  ];
  return routes.some(([pattern, methods]) => pattern.test(raw) && methods.includes(method)) ? `v1/${raw}` : null;
}
